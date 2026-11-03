import { DewarpLens, MountPosition, SourceKind } from '@web-ui-kit/core/dewarp';

export interface DemoStream {
  id: string;
  label: string;
  description: string;
  /** null = not configured; the chip is shown disabled. */
  url: string | null;
  type?: 'auto' | SourceKind;
  mount: MountPosition;
  lens: DewarpLens;
}

export const DEMO_STREAMS: readonly DemoStream[] = [
  {
    id: 'sample-ceiling',
    label: 'Sample - ceiling camera',
    description: 'Synthetic 180° equidistant fisheye, optical axis pointing down.',
    url: 'samples/fisheye-ceiling.webm',
    mount: 'ceiling',
    lens: { fov: 180 },
  },
  {
    id: 'sample-wall',
    label: 'Sample - wall camera',
    description: 'Synthetic 180° equidistant fisheye, optical axis pointing forward.',
    url: 'samples/fisheye-wall.webm',
    mount: 'wall',
    lens: { fov: 180 },
  },
];
