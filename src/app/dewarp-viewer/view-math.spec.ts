import { resolveLens } from './lens-model';
import { MountPosition, ViewState } from './dewarp.types';
import {
  clampView,
  clampVelocity,
  decayVelocity,
  MAX_FLICK_VELOCITY,
  degreesPerPixel,
  IDLE_VELOCITY,
  modesForMount,
  panoramaHalfHeight,
  panoramaSpanDeg,
  panoramaTileAspect,
  panoramaTileHeight,
  wheelToFovFactor,
  writeMountMatrix,
  writeViewMatrix,
} from './view-math';

const lens = resolveLens({ fov: 180 });
const limits = { minFov: 20, maxFov: 110 };
const DEG = Math.PI / 180;

/** M * (x,y,z) for a column-major mat3. */
function apply(m: Float32Array, x: number, y: number, z: number): number[] {
  return [
    m[0] * x + m[3] * y + m[6] * z,
    m[1] * x + m[4] * y + m[7] * z,
    m[2] * x + m[5] * y + m[8] * z,
  ];
}
function det(m: Float32Array): number {
  return (
    m[0] * (m[4] * m[8] - m[7] * m[5]) -
    m[3] * (m[1] * m[8] - m[7] * m[2]) +
    m[6] * (m[1] * m[5] - m[4] * m[2])
  );
}
function view(pan: number, tilt: number, fov = 70): ViewState {
  return { pan, tilt, fov };
}

describe('view matrices', () => {
  const mounts: MountPosition[] = ['wall', 'ceiling', 'floor'];
  for (const mount of mounts) {
    it(`${mount}: pure rotation (det +1, never mirrored)`, () => {
      const m = new Float32Array(9);
      writeViewMatrix(m, 33, -20, mount, 0.3);
      expect(det(m)).toBeCloseTo(1, 5);
      writeMountMatrix(m, mount, 0.3);
      expect(det(m)).toBeCloseTo(1, 5);
    });
  }

  it('wall, pan 0 tilt 0: camera forward is the lens axis', () => {
    const m = new Float32Array(9);
    writeViewMatrix(m, 0, 0, 'wall', 0);
    const [x, y, z] = apply(m, 0, 0, 1);
    expect([x, y, z].map((v) => (Math.abs(v) < 1e-6 ? 0 : v))).toEqual([0, 0, 1]);
  });

  it('wall: positive pan looks right, positive tilt looks up', () => {
    const m = new Float32Array(9);
    writeViewMatrix(m, 30, 0, 'wall', 0);
    expect(apply(m, 0, 0, 1)[0]).toBeGreaterThan(0.4);
    writeViewMatrix(m, 0, 30, 'wall', 0);
    expect(apply(m, 0, 0, 1)[1]).toBeGreaterThan(0.4);
  });

  it('ceiling: tilt -90 stares along the optical axis, tilt 0 is 90 degrees off it', () => {
    const m = new Float32Array(9);
    writeViewMatrix(m, 0, -90, 'ceiling', 0);
    expect(apply(m, 0, 0, 1)[2]).toBeCloseTo(1, 5);
    writeViewMatrix(m, 0, 0, 'ceiling', 0);
    expect(apply(m, 0, 0, 1)[2]).toBeCloseTo(0, 5);
  });

  it('floor: tilt +90 stares along the optical axis', () => {
    const m = new Float32Array(9);
    writeViewMatrix(m, 0, 90, 'floor', 0);
    expect(apply(m, 0, 0, 1)[2]).toBeCloseTo(1, 5);
  });

  it('ceiling: world forward (+z, pan 0) is image up, world right is image right', () => {
    const m = new Float32Array(9);
    writeMountMatrix(m, 'ceiling', 0);
    const fwd = apply(m, 0, 0, 1);
    expect(fwd[1]).toBeCloseTo(1, 6);
    const right = apply(m, 1, 0, 0);
    expect(right[0]).toBeCloseTo(1, 6);
  });

  it('rotation (roll) turns the lens frame without changing the optical axis', () => {
    const m = new Float32Array(9);
    writeViewMatrix(m, 0, 0, 'wall', 90 * DEG);
    const [x, y, z] = apply(m, 0, 0, 1);
    expect(z).toBeCloseTo(1, 6);
    expect(Math.hypot(x, y)).toBeCloseTo(0, 6);
    const up = apply(m, 0, 1, 0);
    expect(up[0]).toBeCloseTo(-1, 6); // up now lands on image-left
  });
});

describe('clampView', () => {
  const clamp = (
    v: ViewState,
    mount: MountPosition,
    mode = 'perspective' as const,
    aspect = 16 / 9,
  ) => clampView(v, lens, mount, mode, aspect, limits, panoramaSpanDeg(mount, lens, null));

  it('limits zoom', () => {
    expect(clamp(view(0, 0, 500), 'wall').fov).toBe(110);
    expect(clamp(view(0, 0, 1), 'wall').fov).toBe(20);
  });

  it('wall: keeps the picture inside a 180 degree lens', () => {
    const v = clamp(view(170, 80), 'wall');
    expect(v.pan).toBeLessThan(90);
    expect(v.tilt).toBeLessThan(90);
    expect(clamp(view(-170, -80), 'wall').pan).toBeGreaterThan(-90);
  });

  it('ceiling: pan wraps, tilt stays between nadir and (horizon - half fov)', () => {
    const v = clamp(view(190, 10), 'ceiling');
    expect(v.pan).toBeCloseTo(-170, 6);
    expect(v.tilt).toBeCloseTo(-90 + (90 - 35), 6); // -35
    expect(clamp(view(0, -200), 'ceiling').tilt).toBe(-90);
  });

  it('floor mirrors ceiling', () => {
    const v = clamp(view(0, -10), 'floor');
    expect(v.tilt).toBeCloseTo(35, 6);
    expect(clamp(view(0, 200), 'floor').tilt).toBe(90);
  });

  it('source mode never touches pan/tilt', () => {
    const v = clamp(view(500, 500), 'ceiling', 'source' as never);
    expect(v.pan).toBe(500);
  });

  it('double panorama on a ceiling keeps both strips above the lens horizon', () => {
    // Regression: tiles are 2x wider than tall; an inverted aspect used to allow
    // far too much tilt so the strips showed only floor.
    const v = clamp(view(0, 0), 'ceiling', 'double-panorama' as never);
    const tileAspect = panoramaTileAspect(Math.PI, (16 / 9) * 2);
    const hMax = panoramaHalfHeight(Math.PI, tileAspect);
    expect(Math.atan(Math.tan(v.tilt * DEG) + hMax)).toBeLessThanOrEqual(1e-9);
    expect(v.tilt).toBeCloseTo(Math.atan(-hMax) / DEG, 5);
  });

  it('survives degenerate sizes', () => {
    expect(() => clamp(view(0, 0), 'ceiling', 'perspective', 0)).not.toThrow();
    expect(Number.isFinite(clamp(view(0, 0), 'ceiling', 'perspective', Number.NaN).tilt)).toBe(
      true,
    );
  });
});

describe('panorama helpers', () => {
  it('auto span: 360 for ceiling/floor, lens-limited <=180 for wall', () => {
    expect(panoramaSpanDeg('ceiling', lens, null)).toBe(360);
    expect(panoramaSpanDeg('wall', lens, null)).toBe(180);
    expect(panoramaSpanDeg('wall', resolveLens({ fov: 120 }), null)).toBeCloseTo(120, 6);
    expect(panoramaSpanDeg('ceiling', lens, 90)).toBe(90);
  });

  it('letterboxes a tall 360 strip but leaves wide ones alone', () => {
    const span = 2 * Math.PI;
    expect(panoramaTileHeight(span, 1600, 900)).toBeLessThan(900);
    expect(panoramaTileHeight(span, 1600, 400)).toBe(400);
    const tile = panoramaTileHeight(span, 1600, 900);
    expect(panoramaHalfHeight(span, 1600 / tile)).toBeLessThanOrEqual(1.3 + 0.01);
  });
});

describe('interaction helpers', () => {
  it('modes depend on the mount', () => {
    expect(modesForMount('wall')).not.toContain('quad');
    expect(modesForMount('ceiling')).toContain('quad');
    expect(modesForMount('floor')).toContain('double-panorama');
  });

  it('wheel zoom: up zooms in, down zooms out, deltas are bounded', () => {
    expect(wheelToFovFactor(-100, 0)).toBeLessThan(1);
    expect(wheelToFovFactor(100, 0)).toBeGreaterThan(1);
    expect(wheelToFovFactor(1e9, 0)).toBeLessThan(2.1);
    expect(wheelToFovFactor(3, 1)).toBeCloseTo(wheelToFovFactor(48, 0));
  });

  it('inertia decays to idle in well under two seconds', () => {
    let v = 300;
    let t = 0;
    while (Math.abs(v) >= IDLE_VELOCITY && t < 5000) {
      v = decayVelocity(v, 16);
      t += 16;
    }
    expect(t).toBeLessThan(2500);
  });

  it('flick velocity is bounded in both directions', () => {
    expect(clampVelocity(1e6)).toBe(MAX_FLICK_VELOCITY);
    expect(clampVelocity(-1e6)).toBe(-MAX_FLICK_VELOCITY);
    expect(clampVelocity(12)).toBe(12);
  });

  it('drag scale is per-mode', () => {
    expect(degreesPerPixel('perspective', 60, 360, 1000, 600)).toBeCloseTo(0.1);
    expect(degreesPerPixel('panorama', 60, 360, 900, 600)).toBeCloseTo(0.4);
    expect(degreesPerPixel('double-panorama', 60, 360, 900, 600)).toBeCloseTo(0.2);
  });
});
