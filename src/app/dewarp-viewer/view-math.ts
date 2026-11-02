import { MountPosition, ViewMode, ViewState } from './dewarp.types';
import { ResolvedLens } from './lens-model';

const DEG = Math.PI / 180;

/*
 * Coordinate conventions
 * ----------------------
 * World frame (left handed): +x right, +y up, +z forward. A virtual camera
 * with pan p and tilt t looks along
 *     f = (sin p cos t, sin t, cos p cos t)
 * (pan > 0 looks right, tilt > 0 looks up).
 *
 * Lens frame: +z is the optical axis, +x is image right, +y is image up.
 * The mount decides how the world maps into it:
 *   wall    : lens = (x, y, z)     axis points forward
 *   ceiling : lens = (x, z, -y)    axis points down
 *   floor   : lens = (x, -z, y)    axis points up
 * All three are proper rotations (determinant +1), i.e. nothing is mirrored.
 *
 * Matrices are column-major Float32Array(9), ready for uniformMatrix3fv.
 */

/** Writes lens-frame coordinates of world vector (x,y,z), then rolls them. */
function toLens(
  mount: MountPosition,
  roll: { c: number; s: number },
  x: number,
  y: number,
  z: number,
  out: Float32Array,
  o: number,
): void {
  let lx: number;
  let ly: number;
  let lz: number;
  switch (mount) {
    case 'ceiling':
      lx = x;
      ly = z;
      lz = -y;
      break;
    case 'floor':
      lx = x;
      ly = -z;
      lz = y;
      break;
    case 'wall':
    default:
      lx = x;
      ly = y;
      lz = z;
      break;
  }
  out[o] = lx * roll.c - ly * roll.s;
  out[o + 1] = lx * roll.s + ly * roll.c;
  out[o + 2] = lz;
}

// Reused so the per-frame path never allocates.
const rollScratch = { c: 1, s: 0 };

/**
 * M such that lensRay = M * cameraRay, where cameraRay is in the virtual
 * camera's own frame (x right, y up, z forward).
 */
export function writeViewMatrix(
  out: Float32Array,
  panDeg: number,
  tiltDeg: number,
  mount: MountPosition,
  rollRad: number,
): void {
  rollScratch.c = Math.cos(rollRad);
  rollScratch.s = Math.sin(rollRad);
  const sp = Math.sin(panDeg * DEG);
  const cp = Math.cos(panDeg * DEG);
  const st = Math.sin(tiltDeg * DEG);
  const ct = Math.cos(tiltDeg * DEG);
  // Column 0: camera right, column 1: camera up, column 2: camera forward.
  toLens(mount, rollScratch, cp, 0, -sp, out, 0);
  toLens(mount, rollScratch, -sp * st, ct, -cp * st, out, 3);
  toLens(mount, rollScratch, sp * ct, st, cp * ct, out, 6);
}

/** M such that lensRay = M * worldRay (no virtual camera; used by panoramas). */
export function writeMountMatrix(out: Float32Array, mount: MountPosition, rollRad: number): void {
  rollScratch.c = Math.cos(rollRad);
  rollScratch.s = Math.sin(rollRad);
  toLens(mount, rollScratch, 1, 0, 0, out, 0);
  toLens(mount, rollScratch, 0, 1, 0, out, 3);
  toLens(mount, rollScratch, 0, 0, 1, out, 6);
}

/** Which view modes make geometric sense for a mount. */
export function modesForMount(mount: MountPosition): readonly ViewMode[] {
  return mount === 'wall' ? WALL_MODES : CEILING_MODES;
}
const WALL_MODES: readonly ViewMode[] = ['perspective', 'panorama', 'source'];
const CEILING_MODES: readonly ViewMode[] = [
  'perspective',
  'panorama',
  'double-panorama',
  'quad',
  'source',
];

/** Azimuth span (degrees) of the `panorama` mode for a mount/lens/override. */
export function panoramaSpanDeg(
  mount: MountPosition,
  lens: ResolvedLens,
  override: number | null | undefined,
): number {
  const max = mount === 'wall' ? Math.min((lens.halfFovRad * 2) / DEG, 180) : 360;
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.min(Math.max(override, 30), 360);
  }
  return max;
}

export interface ViewLimits {
  minFov: number;
  maxFov: number;
}

/** Tallest a panorama strip may be, as a half-height in cylinder-radius units (~52 degrees). */
const PANORAMA_MAX_HALF_HEIGHT = 1.3;

/**
 * Aspect ratio a panorama tile is actually drawn with: never taller than
 * PANORAMA_MAX_HALF_HEIGHT allows. Taller containers are letterboxed instead
 * of stretching the floor over most of the frame.
 */
export function panoramaTileAspect(spanRad: number, containerAspect: number): number {
  return Math.max(containerAspect, spanRad / (2 * PANORAMA_MAX_HALF_HEIGHT));
}

/** Height (in cylinder-radius units) of half of a panorama strip. */
export function panoramaHalfHeight(spanRad: number, aspect: number): number {
  return spanRad / (2 * aspect);
}

/**
 * Letterboxed height in pixels of a panorama tile that has `width` x `height`
 * available; the caller centres it vertically.
 */
export function panoramaTileHeight(spanRad: number, width: number, height: number): number {
  return Math.min(height, Math.round(width / panoramaTileAspect(spanRad, width / height)));
}

function wrap180(deg: number): number {
  const w = ((((deg + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w;
}

/**
 * Pulls `view` back into the range where the picture stays inside the lens
 * image circle (no black wedges) wherever the geometry allows it. Mutates and
 * returns `view`. `aspect` is width/height of one view tile.
 *
 * Panorama modes ignore `fov` (they have a fixed angular scale) but still
 * bound tilt so the strip does not run past the lens horizon.
 */
export function clampView(
  view: ViewState,
  lens: ResolvedLens,
  mount: MountPosition,
  mode: ViewMode,
  aspect: number,
  limits: ViewLimits,
  panoSpanDeg: number,
): ViewState {
  const halfLens = lens.halfFovRad / DEG; // degrees
  const lo = Math.max(limits.minFov, 1);
  const hi = Math.max(limits.maxFov, lo);
  view.fov = Math.min(Math.max(view.fov, lo), hi);
  const safeAspect = aspect > 0.05 ? aspect : 1;

  const isPano = mode === 'panorama' || mode === 'double-panorama';
  const isSource = mode === 'source';
  if (isSource) return view;

  if (isPano) {
    const span = (mode === 'double-panorama' ? 180 : panoSpanDeg) * DEG;
    // Double panorama tiles are half the height of the container, i.e. twice as wide.
    const containerAspect = mode === 'double-panorama' ? safeAspect * 2 : safeAspect;
    const hMax = panoramaHalfHeight(span, panoramaTileAspect(span, containerAspect));
    if (mount === 'wall') {
      const room = Math.max(halfLens - panoSpanDeg * 0.5, 0);
      view.pan = Math.min(Math.max(view.pan, -room), room);
      view.tilt = Math.min(Math.max(view.tilt, -80), 80);
    } else {
      view.pan = wrap180(view.pan);
      const sign = mount === 'ceiling' ? 1 : -1;
      // Elevation of the strip's edge nearest the lens horizon must not
      // exceed the lens FOV; the other edge may reach the pole.
      const edge = Math.tan(Math.max(halfLens - 90, -89) * DEG) - hMax;
      const tiltLimit = Math.atan(edge) / DEG;
      view.tilt =
        sign > 0
          ? Math.min(Math.max(view.tilt, -90), tiltLimit)
          : Math.min(Math.max(view.tilt, -tiltLimit), 90);
    }
    return view;
  }

  const vHalf = view.fov * 0.5;
  const hHalf = Math.atan(Math.tan(vHalf * DEG) * safeAspect) / DEG;
  if (mount === 'wall') {
    const roomX = Math.max(halfLens - hHalf, 0);
    const roomY = Math.max(halfLens - vHalf, 0);
    view.pan = Math.min(Math.max(view.pan, -roomX), roomX);
    view.tilt = Math.min(Math.max(view.tilt, -roomY), roomY);
  } else {
    view.pan = wrap180(view.pan);
    const room = Math.max(halfLens - vHalf, 0);
    view.tilt =
      mount === 'ceiling'
        ? Math.min(Math.max(view.tilt, -90), -90 + room)
        : Math.min(Math.max(view.tilt, 90 - room), 90);
  }
  return view;
}

/** Degrees of pan/tilt per CSS pixel dragged, for the current mode. */
export function degreesPerPixel(
  mode: ViewMode,
  fovDeg: number,
  panoSpanDeg: number,
  cssWidth: number,
  cssHeight: number,
): number {
  if (mode === 'panorama') return panoSpanDeg / Math.max(cssWidth, 1);
  if (mode === 'double-panorama') return 180 / Math.max(cssWidth, 1);
  return fovDeg / Math.max(cssHeight, 1);
}

/** Wheel delta (any deltaMode) to a multiplicative FOV factor (<1 zooms in). */
export function wheelToFovFactor(deltaY: number, deltaMode: number): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(Math.min(Math.max(px, -600), 600) * 0.0012);
}

/** One inertia step: decays a velocity (deg/s) by `dtMs`; returns the new value. */
export function decayVelocity(velocity: number, dtMs: number, tauMs = 220): number {
  return velocity * Math.exp(-dtMs / tauMs);
}

export const IDLE_VELOCITY = 0.4; // deg/s below which inertia stops
export const MAX_FLICK_VELOCITY = 300; // deg/s; bounds how far a fast flick coasts (~65 degrees)
/** Shortest interval used to estimate velocity; coalesced events can share a millisecond. */
export const MIN_VELOCITY_DT_MS = 8;

export function clampVelocity(v: number): number {
  return Math.min(Math.max(v, -MAX_FLICK_VELOCITY), MAX_FLICK_VELOCITY);
}
