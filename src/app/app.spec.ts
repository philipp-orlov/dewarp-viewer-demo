import { TestBed } from '@angular/core/testing';
import { DEWARP_RENDERER_FACTORY, DewarpRendererLike } from '@web-ui-kit/angular/dewarp-viewer';

import { App } from './app';
import { DEMO_STREAMS } from './demo/streams';

/** jsdom has no WebGL 2: the viewer draws through this instead. */
class FakeRenderer implements DewarpRendererLike {
  contextLost = false;
  onContextRestored: (() => void) | null = null;
  resize(): void {}
  upload(): void {}
  render(): void {}
  dispose(): void {}
}

describe('App (the demo page)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: DEWARP_RENDERER_FACTORY, useValue: () => new FakeRenderer() }],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('renders the web-ui-kit viewer and a choice per demo stream', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('ui-dewarp-viewer')).not.toBeNull();
    expect(el.querySelectorAll('.streams [role="radio"]').length).toBe(DEMO_STREAMS.length);
  });

  it('switches the stream, and with it the mount', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    const wall = DEMO_STREAMS.findIndex((s) => s.id === 'sample-wall');
    const radios = el.querySelectorAll<HTMLButtonElement>('.streams [role="radio"]');
    radios[wall].click();
    await fixture.whenStable();
    expect(radios[wall].getAttribute('aria-checked')).toBe('true');
    expect(el.querySelector<HTMLSelectElement>('select')?.value).toBe('wall');
  });
});
