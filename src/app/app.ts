import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { downloadBlob } from '@web-ui-kit/core/dom';

import { DEMO_STREAMS, DemoStream } from './demo/streams';
import {
  DewarpError,
  DewarpLens,
  DewarpViewer,
  MountPosition,
  ViewMode,
} from '@web-ui-kit/angular/dewarp-viewer';

/** Optional deep-link overrides: ?src=<url>&mount=wall|ceiling|floor&lensFov=190&type=hls */
function customStreamFromQuery(): DemoStream | null {
  const q = new URLSearchParams(globalThis.location?.search ?? '');
  const src = q.get('src');
  if (!src) return null;
  const mount = q.get('mount');
  const type = q.get('type');
  return {
    id: 'custom',
    label: 'Custom (?src=)',
    description: src,
    url: src,
    type: type === 'hls' || type === 'video' || type === 'image' ? type : 'auto',
    mount: mount === 'wall' || mount === 'floor' ? mount : 'ceiling',
    lens: { fov: Number(q.get('lensFov')) || 180 },
  };
}

@Component({
  selector: 'app-root',
  imports: [DewarpViewer],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly streams: readonly DemoStream[] = (() => {
    const custom = customStreamFromQuery();
    return custom ? [custom, ...DEMO_STREAMS] : DEMO_STREAMS;
  })();

  protected readonly selected = signal<DemoStream>(
    this.streams.find((s) => s.url) ?? this.streams[0],
  );
  protected readonly mount = signal<MountPosition>(this.selected().mount);
  protected readonly lensFov = signal(this.selected().lens.fov);
  protected readonly lens = computed<DewarpLens>(() => ({
    ...this.selected().lens,
    fov: this.lensFov(),
  }));

  protected readonly mode = signal<ViewMode>('perspective');
  protected readonly pan = signal(0);
  protected readonly tilt = signal(0);
  protected readonly fov = signal(70);
  protected readonly error = signal<DewarpError | null>(null);
  protected readonly mounts: readonly MountPosition[] = ['ceiling', 'wall', 'floor'];

  protected select(stream: DemoStream): void {
    if (!stream.url) return;
    this.error.set(null);
    this.selected.set(stream);
    this.mount.set(stream.mount);
    this.lensFov.set(stream.lens.fov);
    this.pan.set(0);
    this.tilt.set(0);
    this.fov.set(70);
  }

  protected onMount(event: Event): void {
    this.mount.set((event.target as HTMLSelectElement).value as MountPosition);
  }

  protected onLensFov(event: Event): void {
    this.lensFov.set(Number((event.target as HTMLInputElement).value));
  }

  protected async snapshot(viewer: DewarpViewer): Promise<void> {
    const blob = await viewer.snapshot('image/png');
    // The kit's download revokes the object URL only after the browser has
    // started the download (revoking it at once saved nothing in Firefox/Safari).
    if (blob) downloadBlob(`dewarp-${this.mode()}.png`, blob);
  }
}
