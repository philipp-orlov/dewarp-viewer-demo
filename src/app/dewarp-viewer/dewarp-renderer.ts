import { InjectionToken } from '@angular/core';
import { MountPosition, ViewMode } from './dewarp.types';
import { ResolvedLens } from './lens-model';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './shaders';
import {
  panoramaHalfHeight,
  panoramaTileHeight,
  writeMountMatrix,
  writeViewMatrix,
} from './view-math';

const DEG = Math.PI / 180;

/** Everything the renderer needs for one frame. Mutated in place, never reallocated. */
export interface RenderFrame {
  mode: ViewMode;
  mount: MountPosition;
  pan: number;
  tilt: number;
  fov: number;
  panoramaSpanDeg: number;
  lens: ResolvedLens;
}

/** The slice of the renderer the component depends on (swappable in tests). */
export interface DewarpRendererLike {
  readonly contextLost: boolean;
  /** Called after a lost context has been rebuilt; the texture must be re-uploaded. */
  onContextRestored: (() => void) | null;
  /** Sets the drawing-buffer size in device pixels. */
  resize(width: number, height: number): void;
  upload(source: TexImageSource, width: number, height: number): void;
  render(frame: RenderFrame): void;
  dispose(): void;
}

export type DewarpRendererFactory = (canvas: HTMLCanvasElement) => DewarpRendererLike;

export const DEWARP_RENDERER_FACTORY = new InjectionToken<DewarpRendererFactory>(
  'DEWARP_RENDERER_FACTORY',
  { providedIn: 'root', factory: () => (canvas) => new DewarpRenderer(canvas) },
);

interface Uniforms {
  tex: WebGLUniformLocation | null;
  proj: WebGLUniformLocation | null;
  rot: WebGLUniformLocation | null;
  tanHalf: WebGLUniformLocation | null;
  cyl: WebGLUniformLocation | null;
  texSize: WebGLUniformLocation | null;
  centerPx: WebGLUniformLocation | null;
  radiusPx: WebGLUniformLocation | null;
  halfFov: WebGLUniformLocation | null;
  norm: WebGLUniformLocation | null;
  profile: WebGLUniformLocation | null;
  poly: WebGLUniformLocation | null;
  poly5: WebGLUniformLocation | null;
}

const PROJ_RECT = 0;
const PROJ_CYL = 1;
const PROJ_SOURCE = 2;

export class DewarpRenderer implements DewarpRendererLike {
  onContextRestored: (() => void) | null = null;

  private gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private u!: Uniforms;
  private texW = 0;
  private texH = 0;
  private lost = false;
  private width = 1;
  private height = 1;

  // Scratch, allocated once: the render path creates no garbage.
  private readonly rot = new Float32Array(9);

  private readonly onLost = (e: Event): void => {
    e.preventDefault(); // required, otherwise the context is never restored
    this.lost = true;
    this.program = null;
    this.texture = null;
    this.texW = this.texH = 0;
  };
  private readonly onRestored = (): void => {
    this.gl = this.canvas.getContext('webgl2') as WebGL2RenderingContext;
    this.build();
    this.lost = false;
    this.onContextRestored?.();
  };

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL 2 is not available');
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.build();
  }

  get contextLost(): boolean {
    return this.lost;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    if (this.canvas.width !== this.width) this.canvas.width = this.width;
    if (this.canvas.height !== this.height) this.canvas.height = this.height;
  }

  upload(source: TexImageSource, width: number, height: number): void {
    if (this.lost || width <= 0 || height <= 0) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (width !== this.texW || height !== this.texH) {
      // (Re)allocate storage only when the size changes; afterwards the
      // GPU memory is reused in place by texSubImage2D.
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source as TexImageSource,
      );
      this.texW = width;
      this.texH = height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
  }

  render(f: RenderFrame): void {
    if (this.lost || !this.program || this.texW === 0) return;
    const gl = this.gl;
    const W = this.width;
    const H = this.height;
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    this.setLensUniforms(f.lens);

    const roll = f.lens.rotationRad;
    switch (f.mode) {
      case 'source': {
        // Letterbox the raw image into the canvas.
        const texAspect = this.texW / this.texH;
        let w = W;
        let h = Math.round(W / texAspect);
        if (h > H) {
          h = H;
          w = Math.round(H * texAspect);
        }
        gl.viewport((W - w) >> 1, (H - h) >> 1, w, h);
        gl.uniform1i(this.u.proj, PROJ_SOURCE);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        break;
      }
      case 'perspective':
        this.drawRect(0, 0, W, H, f.pan, f, roll);
        break;
      case 'quad': {
        const w0 = W >> 1;
        const h0 = H >> 1;
        // Top-left, top-right, bottom-left, bottom-right; 90 degrees apart.
        this.drawRect(0, h0, w0, H - h0, f.pan, f, roll);
        this.drawRect(w0, h0, W - w0, H - h0, f.pan + 90, f, roll);
        this.drawRect(0, 0, w0, h0, f.pan + 270, f, roll);
        this.drawRect(w0, 0, W - w0, h0, f.pan + 180, f, roll);
        break;
      }
      case 'panorama':
        this.drawCyl(0, 0, W, H, f.panoramaSpanDeg * DEG, f.pan * DEG, f, roll);
        break;
      case 'double-panorama': {
        const h1 = H >> 1;
        this.drawCyl(0, h1, W, H - h1, Math.PI, f.pan * DEG, f, roll); // front
        this.drawCyl(0, 0, W, h1, Math.PI, (f.pan + 180) * DEG, f, roll); // back
        break;
      }
    }
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.onContextRestored = null;
    if (!this.lost) {
      this.gl.deleteTexture(this.texture);
      this.gl.deleteProgram(this.program);
      // Hand the GPU context back immediately instead of waiting for GC;
      // browsers cap live contexts (~16), which matters for many viewers.
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.texture = null;
    this.program = null;
    this.lost = true;
  }

  // -- internals ----------------------------------------------------------

  private drawRect(
    x: number,
    y: number,
    w: number,
    h: number,
    pan: number,
    f: RenderFrame,
    roll: number,
  ): void {
    const gl = this.gl;
    gl.viewport(x, y, w, h);
    writeViewMatrix(this.rot, pan, f.tilt, f.mount, roll);
    const tanV = Math.tan(f.fov * 0.5 * DEG);
    gl.uniform1i(this.u.proj, PROJ_RECT);
    gl.uniformMatrix3fv(this.u.rot, false, this.rot);
    gl.uniform2f(this.u.tanHalf, tanV * (w / h), tanV);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private drawCyl(
    x: number,
    y: number,
    w: number,
    h: number,
    spanRad: number,
    azimuthRad: number,
    f: RenderFrame,
    roll: number,
  ): void {
    const gl = this.gl;
    // Letterbox: the strip never gets taller than its angular scale allows.
    const th = panoramaTileHeight(spanRad, w, h);
    y += (h - th) >> 1;
    h = th;
    gl.viewport(x, y, w, h);
    writeMountMatrix(this.rot, f.mount, roll);
    gl.uniform1i(this.u.proj, PROJ_CYL);
    gl.uniformMatrix3fv(this.u.rot, false, this.rot);
    gl.uniform4f(
      this.u.cyl,
      spanRad,
      azimuthRad,
      panoramaHalfHeight(spanRad, w / h),
      Math.tan(f.tilt * DEG),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private setLensUniforms(lens: ResolvedLens): void {
    const gl = this.gl;
    const minSide = Math.min(this.texW, this.texH);
    gl.uniform2f(this.u.texSize, this.texW, this.texH);
    gl.uniform2f(this.u.centerPx, lens.centerX * this.texW, lens.centerY * this.texH);
    gl.uniform1f(this.u.radiusPx, lens.radius * minSide);
    gl.uniform1f(this.u.halfFov, lens.halfFovRad);
    gl.uniform1f(this.u.norm, lens.norm);
    gl.uniform1i(this.u.profile, lens.profileId);
    gl.uniform4f(this.u.poly, lens.coeffs[0], lens.coeffs[1], lens.coeffs[2], lens.coeffs[3]);
    gl.uniform1f(this.u.poly5, lens.coeffs[4]);
  }

  private build(): void {
    const gl = this.gl;
    const program = gl.createProgram();
    const vs = this.compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this.compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Dewarp shader link failed: ${log}`);
    }
    this.program = program;
    const loc = (n: string): WebGLUniformLocation | null => gl.getUniformLocation(program, n);
    this.u = {
      tex: loc('uTex'),
      proj: loc('uProj'),
      rot: loc('uRot'),
      tanHalf: loc('uTanHalf'),
      cyl: loc('uCyl'),
      texSize: loc('uTexSize'),
      centerPx: loc('uCenterPx'),
      radiusPx: loc('uRadiusPx'),
      halfFov: loc('uHalfFov'),
      norm: loc('uNorm'),
      profile: loc('uProfile'),
      poly: loc('uPoly'),
      poly5: loc('uPoly5'),
    };
    gl.useProgram(program);
    gl.uniform1i(this.u.tex, 0);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.texW = this.texH = 0;
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type) as WebGLShader;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Dewarp shader compile failed: ${log}`);
    }
    return shader;
  }
}
