/** Where the wide-angle camera is mounted; decides what "up" and "pan" mean. */
export type MountPosition = 'wall' | 'ceiling' | 'floor';

/** How the fisheye image is presented. */
export type ViewMode =
  | 'perspective' // single rectilinear pan/tilt/zoom view
  | 'panorama' // one cylindrical strip (180 or 360 degrees)
  | 'double-panorama' // two stacked 180 degree strips (front over back)
  | 'quad' // four rectilinear views 90 degrees apart
  | 'source'; // the raw, un-dewarped fisheye image

/** Radial lens model r(theta); see lens-model.ts. */
export type LensProfile =
  | 'equidistant' // r = theta (most "plain" fisheye)
  | 'equisolid' // r = 2 sin(theta/2)
  | 'stereographic' // r = 2 tan(theta/2)
  | 'orthographic' // r = sin(theta)
  | 'polynomial'; // r = c1 t + c2 t^2 + ... + c5 t^5, supplied via `coefficients`

/**
 * Describes the optics of the camera that produced the source image. Only
 * `fov` is required; the defaults describe a 180 degree equidistant fisheye
 * whose image circle is inscribed in the (centred) frame.
 */
export interface DewarpLens {
  /** Total field of view of the lens in degrees (e.g. 180, 190, 360). */
  fov: number;
  profile?: LensProfile;
  /** c1..c5 of r(theta) for `profile: 'polynomial'` (theta in radians). */
  coefficients?: readonly number[];
  /** Image circle centre, 0..1 of the image width. Default 0.5. */
  centerX?: number;
  /** Image circle centre, 0..1 of the image height. Default 0.5. */
  centerY?: number;
  /** Image circle radius as a fraction of the SHORTER image side. Default 0.5. */
  radius?: number;
  /**
   * Degrees. Where the mount's "up" lands in the image, measured
   * counter-clockwise from the top of the frame. Default 0.
   */
  rotation?: number;
}

export type DewarpSource =
  | string // URL: .mp4/.webm, .m3u8 (HLS) or an image
  | HTMLVideoElement
  | HTMLImageElement
  | HTMLCanvasElement // treated as live: re-uploaded every frame
  | ImageBitmap;

export type SourceKind = 'video' | 'image' | 'hls';

export type DewarpErrorCode =
  | 'webgl-unavailable'
  | 'source' // the media failed to load / decode
  | 'cors' // the browser refused to use the media as a texture
  | 'hls';

export interface DewarpError {
  code: DewarpErrorCode;
  message: string;
}

/** Current virtual-camera orientation, all in degrees. `fov` is vertical. */
export interface ViewState {
  pan: number;
  tilt: number;
  fov: number;
}

export const DEFAULT_FOV = 70;
export const DEFAULT_LENS: Readonly<DewarpLens> = { fov: 180 };
