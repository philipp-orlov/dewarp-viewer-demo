import { SourceKind } from './dewarp.types';

const IMAGE_EXT = /\.(jpe?g|png|webp|avif|gif|bmp)$/i;
const HLS_EXT = /\.m3u8$/i;

/** Picks how to load a URL. `hint` wins unless it is 'auto'. */
export function detectSourceKind(url: string, hint: 'auto' | SourceKind = 'auto'): SourceKind {
  if (hint !== 'auto') return hint;
  // Strip query/fragment so signed URLs ("...m3u8?token=x") still match.
  const path = url.split('#', 1)[0].split('?', 1)[0];
  if (HLS_EXT.test(path)) return 'hls';
  if (IMAGE_EXT.test(path)) return 'image';
  return 'video';
}

type HlsInstance = {
  loadSource(url: string): void;
  attachMedia(media: HTMLMediaElement): void;
  startLoad(): void;
  recoverMediaError(): void;
  destroy(): void;
  on(event: string, cb: (event: string, data: HlsErrorData) => void): void;
};
interface HlsErrorData {
  fatal: boolean;
  type: string;
  details: string;
}

/**
 * Owns one hls.js instance for a <video>. hls.js is a lazy chunk: pages that
 * only ever show mp4/webm/images never download it. Browsers with native HLS
 * (Safari) skip it entirely.
 */
export class HlsAttachment {
  private hls: HlsInstance | null = null;
  private disposed = false;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  async attach(
    video: HTMLVideoElement,
    url: string,
    onFatal: (message: string) => void,
  ): Promise<void> {
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      return;
    }
    const mod = await import('hls.js');
    if (this.disposed) return;
    const Hls = mod.default;
    if (!Hls.isSupported()) {
      onFatal('HLS is not supported by this browser (no Media Source Extensions).');
      return;
    }
    const hls = new Hls({
      lowLatencyMode: true,
      // Bounded buffers keep a days-long live session at constant memory.
      maxBufferLength: 8,
      maxMaxBufferLength: 16,
      backBufferLength: 8,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 8,
      enableWorker: true,
    }) as unknown as HlsInstance;
    this.hls = hls;
    hls.on(Hls.Events.ERROR, (_event: string, data: HlsErrorData) => {
      if (!data.fatal || this.disposed) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.retries < 3) {
        this.retries++;
        hls.recoverMediaError();
      } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.retries < 8) {
        // Live streams drop; retry with a capped backoff instead of giving up.
        const delay = Math.min(1000 * 2 ** this.retries, 15000);
        this.retries++;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (!this.disposed) hls.startLoad();
        }, delay);
      } else {
        onFatal(`HLS stream failed: ${data.details}`);
      }
    });
    hls.on(Hls.Events.FRAG_LOADED, () => {
      this.retries = 0;
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.hls?.destroy();
    this.hls = null;
  }
}
