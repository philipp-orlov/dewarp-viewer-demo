import { DewarpLens, LensProfile } from './dewarp.types';

/** Numeric ids shared with the fragment shader (`uProfile`). */
export const PROFILE_IDS: Readonly<Record<LensProfile, number>> = {
  equidistant: 0,
  equisolid: 1,
  stereographic: 2,
  orthographic: 3,
  polynomial: 4,
};

/** A DewarpLens with every default filled in and every value sanitised. */
export interface ResolvedLens {
  halfFovRad: number;
  profile: LensProfile;
  profileId: number;
  /** c1..c5, always 5 entries. */
  coeffs: Float32Array;
  centerX: number;
  centerY: number;
  radius: number;
  rotationRad: number;
  /** f(halfFov): divisor that makes the unit radius land on the image circle. */
  norm: number;
}

const DEG = Math.PI / 180;

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Unnormalised r(theta). Mirrors `lensRadius()` in the fragment shader. */
export function profileRadius(
  profile: LensProfile,
  theta: number,
  coeffs: ArrayLike<number>,
): number {
  switch (profile) {
    case 'equisolid':
      return 2 * Math.sin(theta * 0.5);
    case 'stereographic':
      return 2 * Math.tan(theta * 0.5);
    case 'orthographic':
      return Math.sin(Math.min(theta, Math.PI * 0.5));
    case 'polynomial': {
      // Horner: t * (c1 + t * (c2 + ...)).
      let acc = coeffs[4];
      acc = acc * theta + coeffs[3];
      acc = acc * theta + coeffs[2];
      acc = acc * theta + coeffs[1];
      acc = acc * theta + coeffs[0];
      return acc * theta;
    }
    case 'equidistant':
    default:
      return theta;
  }
}

/**
 * Validates a user supplied lens. Allocates (once per input change, never per
 * frame). Throws nothing: bad numbers fall back to defaults so a typo cannot
 * take the whole page down.
 */
export function resolveLens(lens: DewarpLens): ResolvedLens {
  const fovDeg = Math.min(Math.max(finiteOr(lens.fov, 180), 10), 360);
  let profile: LensProfile = lens.profile ?? 'equidistant';
  const coeffs = new Float32Array(5);
  if (profile === 'polynomial') {
    const src = lens.coefficients ?? [];
    for (let i = 0; i < 5; i++) coeffs[i] = finiteOr(src[i], 0);
  }
  const halfFovRad = fovDeg * 0.5 * DEG;
  let norm = profileRadius(profile, halfFovRad, coeffs);
  if (!(norm > 1e-6) || !Number.isFinite(norm)) {
    // Degenerate polynomial (or tan() blow-up): behave like an equidistant lens.
    profile = 'equidistant';
    norm = halfFovRad;
  }
  return {
    halfFovRad,
    profile,
    profileId: PROFILE_IDS[profile],
    coeffs,
    centerX: Math.min(Math.max(finiteOr(lens.centerX, 0.5), 0), 1),
    centerY: Math.min(Math.max(finiteOr(lens.centerY, 0.5), 0), 1),
    radius: Math.min(Math.max(finiteOr(lens.radius, 0.5), 0.01), 4),
    rotationRad: finiteOr(lens.rotation, 0) * DEG,
    norm,
  };
}

/** Normalised radius in the image circle (1 at the edge of the lens FOV). */
export function normalizedRadius(lens: ResolvedLens, theta: number): number {
  return profileRadius(lens.profile, theta, lens.coeffs) / lens.norm;
}

/**
 * CPU reference of what the fragment shader does: lens-frame ray (x right,
 * y up, z along the optical axis; need not be normalised) to source pixel
 * coordinates. Returns false when the ray is outside the lens FOV. Used by
 * the tests, and handy for hit-testing / overlays in host applications.
 */
export function rayToImagePixel(
  lens: ResolvedLens,
  imageWidth: number,
  imageHeight: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): boolean {
  const lenXY = Math.hypot(x, y);
  const theta = Math.atan2(lenXY, z);
  if (theta > lens.halfFovRad) return false;
  const r = normalizedRadius(lens, theta) * lens.radius * Math.min(imageWidth, imageHeight);
  const dx = lenXY > 1e-9 ? x / lenXY : 0;
  const dy = lenXY > 1e-9 ? y / lenXY : 0;
  out[0] = lens.centerX * imageWidth + dx * r;
  out[1] = lens.centerY * imageHeight - dy * r; // image rows grow downwards
  return true;
}

/** Inverse of the above: how far from the axis does image radius `r01` (0..1) lie. */
export function thetaFromNormalizedRadius(lens: ResolvedLens, r01: number): number {
  let lo = 0;
  let hi = lens.halfFovRad;
  const target = Math.min(Math.max(r01, 0), 1);
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (normalizedRadius(lens, mid) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}
