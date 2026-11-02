import {
  normalizedRadius,
  rayToImagePixel,
  resolveLens,
  thetaFromNormalizedRadius,
} from './lens-model';
import { LensProfile } from './dewarp.types';

const DEG = Math.PI / 180;
const PROFILES: LensProfile[] = ['equidistant', 'equisolid', 'stereographic'];

describe('lens model', () => {
  it('fills defaults and sanitises junk input', () => {
    const l = resolveLens({ fov: Number.NaN, centerX: 7, radius: -1, rotation: Infinity });
    expect(l.halfFovRad).toBeCloseTo(90 * DEG);
    expect(l.centerX).toBe(1);
    expect(l.radius).toBeGreaterThan(0);
    expect(l.rotationRad).toBe(0);
  });

  it('clamps fov to a sane range', () => {
    expect(resolveLens({ fov: 1 }).halfFovRad).toBeCloseTo(5 * DEG);
    expect(resolveLens({ fov: 999 }).halfFovRad).toBeCloseTo(180 * DEG);
  });

  for (const profile of PROFILES) {
    it(`${profile}: radius is 0 on axis, 1 at the edge, monotonic`, () => {
      const l = resolveLens({ fov: 190, profile });
      expect(normalizedRadius(l, 0)).toBeCloseTo(0, 9);
      expect(normalizedRadius(l, l.halfFovRad)).toBeCloseTo(1, 9);
      let prev = -1;
      for (let i = 0; i <= 50; i++) {
        const r = normalizedRadius(l, (i / 50) * l.halfFovRad);
        expect(r).toBeGreaterThan(prev);
        prev = r;
      }
    });
  }

  it('polynomial profile uses the supplied coefficients', () => {
    const l = resolveLens({ fov: 180, profile: 'polynomial', coefficients: [1, 0.2, 0, 0, 0] });
    expect(l.profile).toBe('polynomial');
    expect(normalizedRadius(l, l.halfFovRad)).toBeCloseTo(1, 9);
    // Positive c2 pushes mid-field points outward vs. equidistant.
    expect(normalizedRadius(l, 45 * DEG)).toBeLessThan(0.5);
  });

  it('degenerate polynomial falls back to equidistant instead of NaN', () => {
    const l = resolveLens({ fov: 180, profile: 'polynomial', coefficients: [] });
    expect(l.profile).toBe('equidistant');
    expect(Number.isFinite(l.norm)).toBe(true);
  });

  it('thetaFromNormalizedRadius inverts normalizedRadius', () => {
    const l = resolveLens({ fov: 200, profile: 'equisolid' });
    for (const t of [0.1, 0.5, 1.0, 1.5]) {
      const r = normalizedRadius(l, t);
      expect(thetaFromNormalizedRadius(l, r)).toBeCloseTo(t, 6);
    }
  });

  describe('rayToImagePixel', () => {
    const out = new Float64Array(2);
    const l = resolveLens({ fov: 180 });

    it('the optical axis lands on the image centre', () => {
      expect(rayToImagePixel(l, 1000, 800, 0, 0, 1, out)).toBe(true);
      expect(out[0]).toBeCloseTo(500);
      expect(out[1]).toBeCloseTo(400);
    });

    it('+x at the FOV edge lands on the circle (radius = half the short side)', () => {
      rayToImagePixel(l, 1000, 800, 1, 0, 0, out);
      expect(out[0]).toBeCloseTo(500 + 400);
      expect(out[1]).toBeCloseTo(400);
    });

    it('+y is image UP (smaller row index)', () => {
      rayToImagePixel(l, 1000, 800, 0, 1, 0, out);
      expect(out[1]).toBeCloseTo(0);
    });

    it('rays behind the lens are rejected', () => {
      expect(rayToImagePixel(l, 1000, 800, 0, 0, -1, out)).toBe(false);
    });
  });
});
