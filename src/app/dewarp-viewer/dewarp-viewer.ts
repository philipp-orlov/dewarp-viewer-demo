import {
  afterNextRender,
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  model,
  numberAttribute,
  output,
  signal,
  untracked,
  viewChild,
  computed,
} from '@angular/core';
import { DEWARP_RENDERER_FACTORY, DewarpRendererLike, RenderFrame } from './dewarp-renderer';
import {
  DEFAULT_FOV,
  DEFAULT_LENS,
  DewarpError,
  DewarpLens,
  DewarpSource,
  MountPosition,
  SourceKind,
  ViewMode,
  ViewState,
} from './dewarp.types';
import { resolveLens } from './lens-model';
import { detectSourceKind, HlsAttachment } from './media-source';
import {
  clampVelocity,
  clampView,
  decayVelocity,
  degreesPerPixel,
  IDLE_VELOCITY,
  MIN_VELOCITY_DT_MS,
  modesForMount,
  panoramaSpanDeg,
  wheelToFovFactor,
} from './view-math';

type Status = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

interface ModeDef {
  id: ViewMode;
  label: string;
  /** SVG path data on a 24x24 grid. */
  icon: string;
}

const MODE_DEFS: readonly ModeDef[] = [
  { id: 'perspective', label: 'Perspective view', icon: 'M4 6h16v12H4zM12 9v6M9 12h6' },
  { id: 'panorama', label: 'Panorama', icon: 'M2 8.5h20v7H2zM2 12h20' },
  { id: 'double-panorama', label: 'Double panorama', icon: 'M2 4.5h20v6H2zM2 13.5h20v6H2z' },
  { id: 'quad', label: 'Quad view', icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' },
  {
    id: 'source',
    label: 'Original fisheye',
    icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  },
];

@Component({
  selector: 'dewarp-viewer',
  templateUrl: './dewarp-viewer.html',
  styleUrl: './dewarp-viewer.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'application',
    tabindex: '0',
    '[attr.aria-label]': 'label()',
    '[class.dv-fullscreen]': 'fullscreen()',
    '(keydown)': 'onKeyDown($event)',
  },
})
export class DewarpViewer {
  // ---- inputs ------------------------------------------------------------
  /** URL (.mp4/.webm/.m3u8/image), or a ready video/image/canvas/ImageBitmap. */
  readonly source = input<DewarpSource | null>(null);
  /** Override URL sniffing. */
  readonly sourceType = input<'auto' | SourceKind>('auto');
  readonly lens = input<DewarpLens>(DEFAULT_LENS);
  readonly mount = input<MountPosition>('ceiling');
  /** Two-way: `[(mode)]`. Falls back to a valid mode if the mount can't show it. */
  readonly mode = model<ViewMode>('perspective');
  /** Two-way, degrees. Clamped so the picture stays inside the lens circle. */
  readonly pan = model(0);
  readonly tilt = model(0);
  /** Vertical field of view of perspective/quad tiles, degrees. */
  readonly fov = model(DEFAULT_FOV);
  readonly minFov = input(20, { transform: numberAttribute });
  readonly maxFov = input(110, { transform: numberAttribute });
  /** Panorama azimuth span in degrees; null = auto (360 ceiling/floor, <=180 wall). */
  readonly panoramaSpan = input<number | null>(null);
  /** Restrict the mode buttons / modes. null = everything the mount supports. */
  readonly modes = input<readonly ViewMode[] | null>(null);
  readonly interactive = input(true, { transform: booleanAttribute });
  readonly showControls = input(true, { transform: booleanAttribute });
  readonly autoplay = input(true, { transform: booleanAttribute });
  readonly muted = input(true, { transform: booleanAttribute });
  readonly loop = input(true, { transform: booleanAttribute });
  /** CORS mode for URLs. WebGL needs `anonymous` + `Access-Control-Allow-Origin` on the media. */
  readonly crossOrigin = input<'anonymous' | 'use-credentials'>('anonymous');
  /** Upper bound on device pixel ratio used for the drawing buffer (GPU cost cap). */
  readonly maxPixelRatio = input(2, { transform: numberAttribute });
  readonly label = input('Dewarped wide-angle camera view');

  // ---- outputs -----------------------------------------------------------
  /** First frame of a source has been uploaded and drawn. */
  readonly loaded = output<void>();
  readonly failed = output<DewarpError>();

  // ---- state -------------------------------------------------------------
  protected readonly status = signal<Status>('idle');
  protected readonly unsupported = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly fullscreen = signal(false);
  private readonly size = signal({ w: 0, h: 0 });

  private readonly lensResolved = computed(() => resolveLens(this.lens()));
  /** Modes selectable for the current mount (and `modes` restriction). */
  protected readonly availableModes = computed(() => {
    const supported = modesForMount(this.mount());
    const wanted = this.modes();
    return wanted ? supported.filter((m) => wanted.includes(m)) : supported;
  });
  protected readonly modeDefs = computed(() =>
    MODE_DEFS.filter((d) => this.availableModes().includes(d.id)),
  );
  protected readonly zoomable = computed(
    () => this.mode() === 'perspective' || this.mode() === 'quad',
  );
  protected readonly canPlayPause = signal(false);

  // ---- internals ---------------------------------------------------------
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly factory = inject(DEWARP_RENDERER_FACTORY);
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly videoRef = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private readonly ready = signal(false);

  private renderer: DewarpRendererLike | null = null;
  private rafId = 0;
  private inertiaRaf = 0;
  private visible = true;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;

  // current media
  /** Aborted on destroy: removes every listener bound in bindInteraction(). */
  private readonly destroyController = new AbortController();
  private abort: AbortController | null = null;
  private hls: HlsAttachment | null = null;
  private media: TexImageSource | null = null;
  private mediaVideo: HTMLVideoElement | null = null;
  private liveCanvas = false;
  private pendingUpload = false;
  private rvfcHandle = 0;
  private firstFrame = false;

  // reusable per-frame state: nothing below is reallocated while rendering
  private readonly frame: RenderFrame = {
    mode: 'perspective',
    mount: 'ceiling',
    pan: 0,
    tilt: 0,
    fov: DEFAULT_FOV,
    panoramaSpanDeg: 360,
    lens: resolveLens(DEFAULT_LENS),
  };
  private readonly scratchView: ViewState = { pan: 0, tilt: 0, fov: DEFAULT_FOV };

  // pointer / gesture state (fixed slots, no per-event allocation)
  private readonly ptrId = [-1, -1];
  private readonly ptrX = [0, 0];
  private readonly ptrY = [0, 0];
  private pinchDist = 0;
  private pinchFov = 0;
  private velPan = 0;
  private velTilt = 0;
  private lastMoveT = 0;
  private lastInertiaT = 0;

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => this.teardown());

    afterNextRender(() => this.init());

    // Source changes (and the initial source once the GL context exists).
    effect(() => {
      const src = this.source();
      const type = this.sourceType();
      if (!this.ready()) return;
      untracked(() => this.attachSource(src, type));
    });

    // Any option that influences the picture.
    effect(() => {
      const modes = this.availableModes();
      const mode = this.mode();
      untracked(() => {
        if (!modes.includes(mode) && modes.length > 0) this.mode.set(modes[0]);
      });
    });

    effect(() => {
      // Read everything the clamp depends on, then clamp-write once.
      const { w, h } = this.size();
      const lens = this.lensResolved();
      const mount = this.mount();
      const mode = this.mode();
      const pan = this.pan();
      const tilt = this.tilt();
      const fov = this.fov();
      const minFov = this.minFov();
      const maxFov = this.maxFov();
      const span = this.panoramaSpan();
      untracked(() => {
        const v = this.scratchView;
        v.pan = pan;
        v.tilt = tilt;
        v.fov = fov;
        const spanDeg = panoramaSpanDeg(mount, lens, span);
        clampView(v, lens, mount, mode, h > 0 ? w / h : 16 / 9, { minFov, maxFov }, spanDeg);
        if (!nearlyEqual(v.pan, pan)) this.pan.set(v.pan);
        if (!nearlyEqual(v.tilt, tilt)) this.tilt.set(v.tilt);
        if (!nearlyEqual(v.fov, fov)) this.fov.set(v.fov);
        this.frame.mode = mode;
        this.frame.mount = mount;
        this.frame.pan = v.pan;
        this.frame.tilt = v.tilt;
        this.frame.fov = v.fov;
        this.frame.panoramaSpanDeg = spanDeg;
        this.frame.lens = lens;
        this.requestRender();
      });
    });
  }

  // ---- public API --------------------------------------------------------

  /** Home position: straight ahead (clamped to the lens), default zoom. */
  reset(): void {
    this.stopInertia();
    this.pan.set(0);
    this.tilt.set(0);
    this.fov.set(DEFAULT_FOV);
  }

  play(): Promise<void> {
    return this.mediaVideo?.play() ?? Promise.resolve();
  }

  pause(): void {
    this.mediaVideo?.pause();
  }

  /** The <video> in use (ours, or the one supplied as `source`), if any. */
  get videoElement(): HTMLVideoElement | null {
    return this.mediaVideo;
  }

  /** Renders the current view and encodes the canvas. */
  snapshot(type = 'image/png', quality?: number): Promise<Blob | null> {
    this.drawNow();
    return new Promise((resolve) => this.canvasRef().nativeElement.toBlob(resolve, type, quality));
  }

  async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement === this.host) await document.exitFullscreen();
      else await this.host.requestFullscreen();
    } catch {
      /* denied or unsupported: nothing useful to do */
    }
  }

  // ---- template handlers -------------------------------------------------

  protected setMode(mode: ViewMode): void {
    this.mode.set(mode);
  }

  protected zoom(factor: number): void {
    this.fov.set(this.fov() * factor);
  }

  protected togglePlay(): void {
    const v = this.mediaVideo;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  }

  protected onKeyDown(e: KeyboardEvent): void {
    if (!this.interactive() || e.altKey || e.ctrlKey || e.metaKey) return;
    const step = 5 * (this.fov() / DEFAULT_FOV);
    switch (e.key) {
      case 'ArrowLeft':
        this.pan.set(this.pan() - step);
        break;
      case 'ArrowRight':
        this.pan.set(this.pan() + step);
        break;
      case 'ArrowUp':
        this.tilt.set(this.tilt() + step);
        break;
      case 'ArrowDown':
        this.tilt.set(this.tilt() - step);
        break;
      case '+':
      case '=':
        if (this.zoomable()) this.zoom(1 / 1.15);
        break;
      case '-':
        if (this.zoomable()) this.zoom(1.15);
        break;
      case '0':
      case 'Home':
        this.reset();
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  // ---- lifecycle ---------------------------------------------------------

  private init(): void {
    const canvas = this.canvasRef().nativeElement;
    try {
      this.renderer = this.factory(canvas);
    } catch (err) {
      this.unsupported.set(true);
      this.failed.emit({
        code: 'webgl-unavailable',
        message: err instanceof Error ? err.message : 'WebGL 2 is not available',
      });
      return;
    }
    this.renderer.onContextRestored = () => {
      this.applySize();
      this.pendingUpload = this.media !== null;
      this.requestRender();
    };

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.applySize());
      this.resizeObserver.observe(this.host);
    }
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        const wasVisible = this.visible;
        this.visible = entries[entries.length - 1].isIntersecting;
        if (this.visible && !wasVisible) {
          this.pendingUpload = this.media !== null;
          this.requestRender();
        }
      });
      this.intersectionObserver.observe(this.host);
    }

    this.bindInteraction(canvas);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    this.applySize();
    this.ready.set(true);
  }

  private teardown(): void {
    this.destroyController.abort();
    cancelAnimationFrame(this.rafId);
    this.stopInertia();
    this.detachSource();
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    this.renderer?.dispose();
    this.renderer = null;
  }

  private readonly onFullscreenChange = (): void => {
    this.fullscreen.set(document.fullscreenElement === this.host);
  };

  private applySize(): void {
    const r = this.renderer;
    if (!r) return;
    const rect = this.host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio());
    // Hard cap on drawing-buffer pixels bounds GPU memory on huge/hi-dpi windows.
    const maxPixels = 3840 * 2160;
    let scale = dpr;
    const px = rect.width * scale * rect.height * scale;
    if (px > maxPixels) scale *= Math.sqrt(maxPixels / px);
    r.resize(
      Math.max(1, Math.round(rect.width * scale)),
      Math.max(1, Math.round(rect.height * scale)),
    );
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    const cur = this.size();
    if (cur.w !== w || cur.h !== h) this.size.set({ w, h });
    this.requestRender();
  }

  // ---- media -------------------------------------------------------------

  private detachSource(): void {
    this.abort?.abort();
    this.abort = null;
    this.hls?.dispose();
    this.hls = null;
    if (this.mediaVideo && this.rvfcHandle) {
      this.mediaVideo.cancelVideoFrameCallback?.(this.rvfcHandle);
    }
    this.rvfcHandle = 0;
    const own = this.videoRef().nativeElement;
    if (this.mediaVideo === own) {
      own.pause();
      own.removeAttribute('src');
      own.load(); // releases the decoder and network connection
    }
    this.media = null;
    this.mediaVideo = null;
    this.liveCanvas = false;
    this.pendingUpload = false;
    this.firstFrame = false;
    this.canPlayPause.set(false);
  }

  private attachSource(src: DewarpSource | null, type: 'auto' | SourceKind): void {
    this.detachSource();
    this.message.set(null);
    if (!src) {
      this.status.set('idle');
      this.requestRender();
      return;
    }
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.status.set('loading');

    if (typeof src === 'string') {
      const kind = detectSourceKind(src, type);
      if (kind === 'image') {
        const img = new Image();
        img.crossOrigin = this.crossOrigin();
        img.decoding = 'async';
        img.addEventListener('load', () => this.setStatic(img, img.naturalWidth), { signal });
        img.addEventListener('error', () => this.fail('source', `Could not load image ${src}`), {
          signal,
        });
        img.src = src;
        return;
      }
      const video = this.videoRef().nativeElement;
      video.crossOrigin = this.crossOrigin();
      this.bindVideo(video, signal, true);
      if (kind === 'hls') {
        this.hls = new HlsAttachment();
        this.hls
          .attach(video, src, (m) => this.fail('hls', m))
          .then(() => this.startPlayback(video))
          .catch((e: unknown) => this.fail('hls', String(e)));
      } else {
        video.src = src;
        this.startPlayback(video);
      }
      return;
    }
    if (src instanceof HTMLVideoElement) {
      this.bindVideo(src, signal, false);
      if (src.readyState >= 2) this.onVideoReady(src);
      return;
    }
    if (src instanceof HTMLImageElement) {
      if (src.complete && src.naturalWidth > 0) this.setStatic(src, src.naturalWidth);
      else {
        src.addEventListener('load', () => this.setStatic(src, src.naturalWidth), { signal });
        src.addEventListener('error', () => this.fail('source', 'Could not load image'), {
          signal,
        });
      }
      return;
    }
    if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) {
      this.liveCanvas = true; // a canvas cannot tell us when it changes
      this.media = src;
      this.status.set('playing');
      this.pendingUpload = true;
      this.requestRender();
      return;
    }
    this.setStatic(src as ImageBitmap, (src as ImageBitmap).width);
  }

  private setStatic(el: TexImageSource, width: number): void {
    if (width <= 0) {
      this.fail('source', 'The image has no pixels');
      return;
    }
    this.media = el;
    this.status.set('paused');
    this.pendingUpload = true;
    this.requestRender();
  }

  private bindVideo(video: HTMLVideoElement, signal: AbortSignal, owned: boolean): void {
    this.mediaVideo = video;
    if (owned) {
      video.muted = this.muted();
      video.loop = this.loop();
      video.playsInline = true;
      video.preload = 'auto';
    }
    this.canPlayPause.set(true);
    const on = (type: string, fn: () => void): void => video.addEventListener(type, fn, { signal });
    on('loadeddata', () => this.onVideoReady(video));
    on('playing', () => {
      this.status.set('playing');
      this.armFrameCallback(video);
    });
    on('pause', () => this.status.set('paused'));
    on('seeked', () => {
      this.pendingUpload = true;
      this.requestRender();
    });
    on('error', () =>
      this.fail('source', video.error?.message || 'The video could not be loaded or decoded'),
    );
  }

  private startPlayback(video: HTMLVideoElement): void {
    if (!this.autoplay()) {
      this.status.set('paused');
      return;
    }
    video.play().catch(() => {
      // Autoplay refused (unmuted media / no gesture): wait for the user.
      this.status.set('paused');
    });
  }

  private onVideoReady(video: HTMLVideoElement): void {
    this.media = video;
    this.pendingUpload = true;
    this.armFrameCallback(video);
    this.requestRender();
  }

  /** One persistent callback; re-armed from itself so no closures are created per frame. */
  private readonly onVideoFrame = (): void => {
    this.rvfcHandle = 0;
    this.pendingUpload = true;
    this.requestRender();
    if (this.mediaVideo) this.armFrameCallback(this.mediaVideo);
  };

  private armFrameCallback(video: HTMLVideoElement): void {
    if (this.rvfcHandle || typeof video.requestVideoFrameCallback !== 'function') return;
    this.rvfcHandle = video.requestVideoFrameCallback(this.onVideoFrame);
  }

  private fail(code: DewarpError['code'], message: string): void {
    this.status.set('error');
    this.message.set(message);
    this.failed.emit({ code, message });
  }

  // ---- rendering ---------------------------------------------------------

  private requestRender(): void {
    if (this.rafId || !this.renderer) return;
    this.rafId = requestAnimationFrame(this.draw);
  }

  private readonly draw = (): void => {
    this.rafId = 0;
    this.drawNow();
    // Sources that cannot announce new frames are polled once per display frame.
    const v = this.mediaVideo;
    const noRvfc = v !== null && typeof v.requestVideoFrameCallback !== 'function';
    if (this.liveCanvas || (noRvfc && !v.paused && !v.ended)) {
      this.pendingUpload = true;
      this.requestRender();
    }
  };

  private drawNow(): void {
    const r = this.renderer;
    if (!r || r.contextLost || !this.visible) return;
    if (this.pendingUpload && this.media) {
      this.pendingUpload = false;
      const { el, w, h } = this.mediaSize(this.media);
      if (w > 0 && h > 0) {
        try {
          r.upload(el, w, h);
        } catch (err) {
          const name = err instanceof DOMException ? err.name : '';
          if (name === 'SecurityError') {
            this.fail(
              'cors',
              'The browser blocked this media as a WebGL texture. The server must send ' +
                'Access-Control-Allow-Origin for this origin.',
            );
          } else {
            this.fail('source', String(err));
          }
          this.media = null;
          return;
        }
        if (!this.firstFrame) {
          this.firstFrame = true;
          r.render(this.frame);
          this.loaded.emit();
          return;
        }
      }
    }
    r.render(this.frame);
  }

  private mediaSize(m: TexImageSource): { el: TexImageSource; w: number; h: number } {
    const s = this.sizeScratch;
    s.el = m;
    if (m instanceof HTMLVideoElement) {
      s.w = m.videoWidth;
      s.h = m.videoHeight;
    } else if (m instanceof HTMLImageElement) {
      s.w = m.naturalWidth;
      s.h = m.naturalHeight;
    } else {
      s.w = (m as ImageBitmap).width;
      s.h = (m as ImageBitmap).height;
    }
    return s;
  }
  private readonly sizeScratch: { el: TexImageSource; w: number; h: number } = {
    el: undefined as unknown as TexImageSource,
    w: 0,
    h: 0,
  };

  // ---- interaction -------------------------------------------------------

  private bindInteraction(canvas: HTMLCanvasElement): void {
    const signal = this.destroyController.signal;
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e, canvas), { signal });
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e), { signal });
    canvas.addEventListener('pointerup', (e) => this.onPointerEnd(e, canvas), { signal });
    canvas.addEventListener('pointercancel', (e) => this.onPointerEnd(e, canvas), { signal });
    canvas.addEventListener('dblclick', () => this.interactive() && this.reset(), { signal });
    // Not passive: we preventDefault so wheel-zoom does not scroll the page.
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { signal, passive: false });
  }

  private slotOf(id: number): number {
    return this.ptrId[0] === id ? 0 : this.ptrId[1] === id ? 1 : -1;
  }

  private onPointerDown(e: PointerEvent, canvas: HTMLCanvasElement): void {
    if (!this.interactive()) return;
    let slot = this.slotOf(e.pointerId);
    if (slot < 0) slot = this.ptrId[0] < 0 ? 0 : this.ptrId[1] < 0 ? 1 : -1;
    if (slot < 0) return;
    this.ptrId[slot] = e.pointerId;
    this.ptrX[slot] = e.clientX;
    this.ptrY[slot] = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    this.stopInertia();
    this.velPan = this.velTilt = 0;
    this.lastMoveT = e.timeStamp;
    if (this.ptrId[0] >= 0 && this.ptrId[1] >= 0) {
      this.pinchDist = Math.hypot(this.ptrX[0] - this.ptrX[1], this.ptrY[0] - this.ptrY[1]);
      this.pinchFov = this.fov();
    }
    canvas.classList.add('dv-grabbing');
  }

  private onPointerMove(e: PointerEvent): void {
    const slot = this.slotOf(e.pointerId);
    if (slot < 0) return;
    const dx = e.clientX - this.ptrX[slot];
    const dy = e.clientY - this.ptrY[slot];
    this.ptrX[slot] = e.clientX;
    this.ptrY[slot] = e.clientY;

    if (this.ptrId[0] >= 0 && this.ptrId[1] >= 0) {
      if (this.zoomable() && this.pinchDist > 0) {
        const d = Math.hypot(this.ptrX[0] - this.ptrX[1], this.ptrY[0] - this.ptrY[1]);
        if (d > 0) this.fov.set(this.pinchFov * (this.pinchDist / d));
      }
      return;
    }
    const { h, w } = this.size();
    const k = degreesPerPixel(this.frame.mode, this.frame.fov, this.frame.panoramaSpanDeg, w, h);
    const dPan = -dx * k;
    const dTilt = dy * k;
    this.pan.set(this.pan() + dPan);
    this.tilt.set(this.tilt() + dTilt);
    const dt = Math.max(e.timeStamp - this.lastMoveT, MIN_VELOCITY_DT_MS);
    this.lastMoveT = e.timeStamp;
    // Low-pass filtered release velocity in deg/s.
    this.velPan = clampVelocity(0.7 * this.velPan + 0.3 * ((dPan / dt) * 1000));
    this.velTilt = clampVelocity(0.7 * this.velTilt + 0.3 * ((dTilt / dt) * 1000));
  }

  private onPointerEnd(e: PointerEvent, canvas: HTMLCanvasElement): void {
    const slot = this.slotOf(e.pointerId);
    if (slot < 0) return;
    this.ptrId[slot] = -1;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (this.ptrId[0] < 0 && this.ptrId[1] < 0) {
      canvas.classList.remove('dv-grabbing');
      const idleFor = e.timeStamp - this.lastMoveT;
      if (idleFor < 80 && Math.hypot(this.velPan, this.velTilt) > 8) this.startInertia();
    }
  }

  private onWheel(e: WheelEvent): void {
    if (!this.interactive() || !this.zoomable()) return;
    e.preventDefault();
    this.fov.set(this.fov() * wheelToFovFactor(e.deltaY, e.deltaMode));
  }

  private startInertia(): void {
    this.lastInertiaT = performance.now();
    this.inertiaRaf = requestAnimationFrame(this.inertiaStep);
  }

  private stopInertia(): void {
    if (this.inertiaRaf) cancelAnimationFrame(this.inertiaRaf);
    this.inertiaRaf = 0;
  }

  private readonly inertiaStep = (now: number): void => {
    const dt = Math.min(now - this.lastInertiaT, 64);
    this.lastInertiaT = now;
    this.velPan = decayVelocity(this.velPan, dt);
    this.velTilt = decayVelocity(this.velTilt, dt);
    if (Math.hypot(this.velPan, this.velTilt) < IDLE_VELOCITY) {
      this.inertiaRaf = 0;
      return;
    }
    this.pan.set(this.pan() + (this.velPan * dt) / 1000);
    this.tilt.set(this.tilt() + (this.velTilt * dt) / 1000);
    this.inertiaRaf = requestAnimationFrame(this.inertiaStep);
  };
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}
