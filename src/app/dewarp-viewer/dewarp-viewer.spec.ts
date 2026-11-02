import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DewarpViewer } from './dewarp-viewer';
import { DEWARP_RENDERER_FACTORY, DewarpRendererLike, RenderFrame } from './dewarp-renderer';
import { DewarpError } from './dewarp.types';

class FakeRenderer implements DewarpRendererLike {
  contextLost = false;
  onContextRestored: (() => void) | null = null;
  disposed = false;
  resizes: Array<[number, number]> = [];
  uploads: Array<{ w: number; h: number }> = [];
  frames: Array<Pick<RenderFrame, 'mode' | 'mount' | 'pan' | 'tilt' | 'fov'>> = [];
  uploadError: Error | null = null;

  resize(w: number, h: number): void {
    this.resizes.push([w, h]);
  }
  upload(_s: TexImageSource, w: number, h: number): void {
    if (this.uploadError) throw this.uploadError;
    this.uploads.push({ w, h });
  }
  render(f: RenderFrame): void {
    this.frames.push({ mode: f.mode, mount: f.mount, pan: f.pan, tilt: f.tilt, fov: f.fov });
  }
  dispose(): void {
    this.disposed = true;
  }
  get last() {
    return this.frames[this.frames.length - 1];
  }
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  await nextFrame();
  await nextFrame();
  fixture.detectChanges();
}

function fakeImage(width = 640, height = 480): HTMLImageElement {
  const img = new Image();
  Object.defineProperty(img, 'complete', { value: true });
  Object.defineProperty(img, 'naturalWidth', { value: width });
  Object.defineProperty(img, 'naturalHeight', { value: height });
  return img;
}

describe('DewarpViewer', () => {
  let fake: FakeRenderer;

  function create(factory?: () => DewarpRendererLike) {
    TestBed.configureTestingModule({
      providers: [{ provide: DEWARP_RENDERER_FACTORY, useValue: factory ?? (() => fake) }],
    });
    const fixture = TestBed.createComponent(DewarpViewer);
    return { fixture, cmp: fixture.componentInstance, el: fixture.nativeElement as HTMLElement };
  }

  beforeEach(() => {
    fake = new FakeRenderer();
    // jsdom doesn't implement media playback.
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  });
  afterEach(() => vi.restoreAllMocks());

  it('creates the renderer after first render and sizes it', async () => {
    const { fixture } = create();
    await settle(fixture);
    expect(fake.resizes.length).toBeGreaterThan(0);
    expect(fake.uploads.length).toBe(0); // nothing to show yet, and no crash
  });

  it('uploads a still image once and draws it', async () => {
    const { fixture } = create();
    const loaded = vi.fn();
    fixture.componentInstance.loaded.subscribe(loaded);
    fixture.componentRef.setInput('source', fakeImage(800, 600));
    await settle(fixture);
    expect(fake.uploads).toEqual([{ w: 800, h: 600 }]);
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(fake.frames.length).toBeGreaterThan(0);
  });

  it('does not re-upload a still image when only the view changes', async () => {
    const { fixture, cmp } = create();
    fixture.componentRef.setInput('source', fakeImage());
    await settle(fixture);
    const uploads = fake.uploads.length;
    cmp.pan.set(10);
    await settle(fixture);
    expect(fake.uploads.length).toBe(uploads);
    expect(fake.last.pan).toBeCloseTo(10);
  });

  it('falls back to a supported mode when the mount cannot show the current one', async () => {
    const { fixture, cmp } = create();
    fixture.componentRef.setInput('mount', 'ceiling');
    cmp.mode.set('quad');
    await settle(fixture);
    expect(cmp.mode()).toBe('quad');
    fixture.componentRef.setInput('mount', 'wall');
    await settle(fixture);
    expect(cmp.mode()).toBe('perspective');
  });

  it('writes clamped values back to the two-way models', async () => {
    const { fixture, cmp } = create();
    fixture.componentRef.setInput('mount', 'ceiling');
    cmp.tilt.set(60);
    cmp.fov.set(500);
    await settle(fixture);
    expect(cmp.fov()).toBe(110);
    // fov is clamped first (110 => 55 degree half-fov), so the tilt ceiling is -90 + (90 - 55).
    expect(cmp.tilt()).toBeCloseTo(-55, 4);
  });

  it('keyboard: arrows pan/tilt, 0 resets, +/- zoom', async () => {
    const { fixture, cmp, el } = create();
    fixture.componentRef.setInput('mount', 'wall');
    await settle(fixture);
    const key = (k: string) =>
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowRight');
    expect(cmp.pan()).toBeCloseTo(5);
    key('ArrowUp');
    expect(cmp.tilt()).toBeCloseTo(5);
    key('+');
    expect(cmp.fov()).toBeLessThan(70);
    key('0');
    await settle(fixture);
    expect(cmp.pan()).toBe(0);
    expect(cmp.fov()).toBe(70);
  });

  it('ignores keys when not interactive', async () => {
    const { fixture, cmp, el } = create();
    fixture.componentRef.setInput('interactive', false);
    await settle(fixture);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(cmp.pan()).toBe(0);
  });

  it('mode buttons reflect the mount and switch modes', async () => {
    const { fixture, cmp, el } = create();
    fixture.componentRef.setInput('mount', 'ceiling');
    await settle(fixture);
    const radios = () => Array.from(el.querySelectorAll<HTMLButtonElement>('[role=radio]'));
    expect(radios().length).toBe(5);
    radios()[3].click(); // quad
    await settle(fixture);
    expect(cmp.mode()).toBe('quad');
    expect(radios()[3].getAttribute('aria-checked')).toBe('true');
    fixture.componentRef.setInput('mount', 'wall');
    await settle(fixture);
    expect(radios().length).toBe(3);
  });

  it('`modes` restricts the buttons', async () => {
    const { fixture, el } = create();
    fixture.componentRef.setInput('modes', ['perspective', 'source']);
    await settle(fixture);
    expect(el.querySelectorAll('[role=radio]').length).toBe(2);
  });

  it('showControls=false removes the toolbar', async () => {
    const { fixture, el } = create();
    fixture.componentRef.setInput('showControls', false);
    await settle(fixture);
    expect(el.querySelector('.dv-bar')).toBeNull();
  });

  it('reports WebGL 2 being unavailable instead of throwing', async () => {
    const { fixture, el, cmp } = create(() => {
      throw new Error('WebGL 2 is not available');
    });
    const errors: DewarpError[] = [];
    cmp.failed.subscribe((e) => errors.push(e));
    await settle(fixture);
    expect(errors[0].code).toBe('webgl-unavailable');
    expect(el.querySelector('.dv-message')?.textContent).toContain('WebGL 2');
  });

  it('turns a texture SecurityError into an actionable cors error', async () => {
    const { fixture, cmp } = create();
    const errors: DewarpError[] = [];
    cmp.failed.subscribe((e) => errors.push(e));
    fake.uploadError = new DOMException('tainted', 'SecurityError');
    fixture.componentRef.setInput('source', fakeImage());
    await settle(fixture);
    expect(errors[0].code).toBe('cors');
    expect(errors[0].message).toContain('Access-Control-Allow-Origin');
  });

  it('re-uploads after a lost context is restored', async () => {
    const { fixture } = create();
    fixture.componentRef.setInput('source', fakeImage());
    await settle(fixture);
    const before = fake.uploads.length;
    fake.onContextRestored?.();
    await settle(fixture);
    expect(fake.uploads.length).toBe(before + 1);
  });

  it('disposes the renderer and stops drawing on destroy', async () => {
    const { fixture } = create();
    fixture.componentRef.setInput('source', fakeImage());
    await settle(fixture);
    fixture.destroy();
    expect(fake.disposed).toBe(true);
    const frames = fake.frames.length;
    await nextFrame();
    await nextFrame();
    expect(fake.frames.length).toBe(frames);
  });

  it('switching source away releases the owned video decoder', async () => {
    const { fixture, cmp } = create();
    fixture.componentRef.setInput('autoplay', false);
    fixture.componentRef.setInput('source', 'clip.webm');
    await settle(fixture);
    expect(cmp.videoElement?.getAttribute('src')).toBe('clip.webm');
    fixture.componentRef.setInput('source', null);
    await settle(fixture);
    expect(cmp.videoElement).toBeNull();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
  });
});
