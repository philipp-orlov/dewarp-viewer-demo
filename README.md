# dewarp-viewer

A reusable Angular component that dewarps wide-angle (fisheye) video and images
in the browser: pick a
stream, drag to pan/tilt, scroll or pinch to zoom, switch between perspective,
panorama, double-panorama, quad and original-fisheye views.

All dewarping runs on the GPU (WebGL 2, one fragment shader). No server-side
processing and no runtime dependencies beyond Angular; `hls.js` is lazy-loaded
only for `.m3u8` sources.

## Use

```ts
import { DewarpViewer } from './app/dewarp-viewer/public-api';

@Component({
  imports: [DewarpViewer],
  template: `
    <dewarp-viewer
      source="https://example.com/camera.m3u8"
      [lens]="{ fov: 180 }"
      mount="ceiling"
      [(mode)]="mode"
      [(pan)]="pan"
      [(tilt)]="tilt"
      [(fov)]="zoom"
      (failed)="onError($event)"
    />
  `,
})
```

Size it with CSS (`width`, plus `height` or the default `aspect-ratio: 16/9`).

### Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `source` | `null` | URL (`.mp4`/`.webm`/`.m3u8`/image) or a ready `HTMLVideoElement`, `HTMLImageElement`, `HTMLCanvasElement` (treated as live) or `ImageBitmap`. |
| `sourceType` | `'auto'` | `'video' \| 'image' \| 'hls'` to override URL sniffing. |
| `lens` | `{ fov: 180 }` | `fov` (deg), `profile` (`equidistant`, `equisolid`, `stereographic`, `orthographic`, `polynomial` + `coefficients`), `centerX/centerY` (0..1), `radius` (fraction of the shorter side), `rotation` (deg). |
| `mount` | `'ceiling'` | `'wall' \| 'ceiling' \| 'floor'`. Decides the optical axis and which modes are offered. |
| `mode` *(two-way)* | `'perspective'` | `'perspective' \| 'panorama' \| 'double-panorama' \| 'quad' \| 'source'`. Falls back automatically if the mount cannot show it (wall has no quad / double panorama). |
| `pan`, `tilt`, `fov` *(two-way)* | `0`, `0`, `70` | Degrees; `fov` is the vertical field of view. Written back clamped so the picture stays inside the lens image circle. |
| `minFov`, `maxFov` | `20`, `110` | Zoom limits. |
| `panoramaSpan` | auto | Azimuth span in degrees (360 ceiling/floor, up to 180 wall). |
| `modes` | `null` | Restrict the mode buttons. |
| `interactive`, `showControls` | `true` | Pointer/keyboard input and the toolbar. |
| `autoplay`, `muted`, `loop` | `true` | For URL video sources. |
| `crossOrigin` | `'anonymous'` | See the CORS note below. |
| `maxPixelRatio` | `2` | Caps the drawing-buffer DPR (and total pixels at 4K) to bound GPU cost. |

Outputs: `loaded` (first frame drawn), `failed` (`{ code, message }`, codes
`webgl-unavailable | source | cors | hls`).
Methods: `reset()`, `play()`, `pause()`, `snapshot(type?, quality?)`,
`toggleFullscreen()`, `videoElement`.

Controls: drag = pan/tilt (with inertia), wheel / pinch = zoom, double-click or
`0` = reset, arrow keys = pan/tilt, `+`/`-` = zoom.

### CORS

The video is uploaded to a WebGL texture, so the browser requires CORS: the media
server must send `Access-Control-Allow-Origin` for your origin. Without it the
component emits `failed` with `code: 'cors'` rather than showing black.

## Demo

```sh
npm install
npm start          # http://localhost:4200
npm test           # vitest + jsdom (pure math + component with a fake renderer)
npm run build
```

`src/app/demo/streams.ts` lists the demo streams. Two synthetic fisheye clips
ship in `public/samples/` (regenerate with `python3 scripts/make-samples.py`;
needs numpy, Pillow, ffmpeg). Any stream can be tried without a rebuild:

```
http://localhost:4200/?src=<url>&mount=ceiling&lensFov=180&type=hls
```

## Design notes

- **No per-frame allocation.** The render path reuses one `RenderFrame`, one
  `Float32Array(9)` and fixed pointer slots; the fullscreen triangle is generated
  from `gl_VertexID` (no buffers). Texture storage is allocated once and updated
  with `texSubImage2D`.
- **Render on demand.** Video frames drive drawing through
  `requestVideoFrameCallback`; a paused video, an idle view, or an off-screen
  viewer costs no GPU work. Browsers without rVFC fall back to one draw per
  display frame while playing.
- **Bounded memory in long runs.** hls.js buffers are capped, live streams retry
  with capped backoff, listeners are removed through `AbortController`, the
  decoder is released when the source changes, and the GL context is handed back
  on destroy. A 90 s soak (continuous playback + drag/zoom/mode changes) held
  the JS heap flat at ~3.9 MB with constant listener and DOM-node counts.
- **Context loss** is handled: the program/texture are rebuilt and the current
  frame re-uploaded.
- **Geometry** (see the comment at the top of `view-math.ts`): left-handed world,
  mounts are proper rotations so nothing is mirrored. Verified against an
  independently rendered ground-truth view of a cube room (mean error 3.3/255
  after blurring, remaining difference is thin-line resampling).

## Known limits

- Equidistant, equisolid, stereographic, orthographic and polynomial radial
  models only; no per-lens calibration files.
- Source textures are bilinear-filtered without mipmaps: very high-resolution
  sources shown in small tiles can shimmer on thin detail.
- The HLS path (lazy `hls.js`) was built but not exercised against a real live
  stream here; the logic for choosing it is unit-tested.
