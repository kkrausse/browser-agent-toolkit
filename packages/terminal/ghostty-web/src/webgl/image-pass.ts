/**
 * Image pass — the seam for Ghostty/Kitty graphics.
 *
 * Kitty's protocol places an image at a cell anchor with a z-index: z < 0 paints
 * under the text, z >= 0 over it. That is the only reason this is a separate
 * pass rather than a glyph — the renderer draws it twice, once on each side of
 * the glyph pass, so the compositing order is right regardless of what the VT
 * layer eventually feeds in.
 *
 * This wrapper does not yet expose native VT graphics state. Integrating it
 * requires a translation layer that converts placements to `ImagePlacement`s
 * in viewport-relative rows; this pass already handles compositing them.
 *
 * Placement counts are small (tens), so each one is its own draw call with
 * uniforms; instancing would buy nothing and cost a texture-per-instance
 * indirection.
 */

import { compileProgram } from './gl-utils';

const VERTEX_SHADER = `#version 300 es
uniform vec4 u_rect;        // x, y, w, h in device pixels
uniform vec4 u_tex;         // u, v, uw, vh normalized source rect
uniform vec2 u_resolution;
out vec2 v_uv;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 pixel = u_rect.xy + corner * u_rect.zw;
  vec2 clip = pixel / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = u_tex.xy + corner * u_tex.zw;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform sampler2D u_image;
uniform float u_opacity;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 texel = texture(u_image, v_uv);
  float a = texel.a * u_opacity;
  outColor = vec4(texel.rgb * a, a);
}`;

export interface ImagePlacement {
  /** Stable identity for the placement (image id + placement id upstream). */
  id: string;
  /** Pixel source. Re-passing the same object reuses the uploaded texture. */
  source: TexImageSource;
  /** Anchor cell, viewport-relative. Fractional values are honored. */
  col: number;
  row: number;
  /** Destination size in cells. */
  cols: number;
  rows: number;
  /** Additional offset inside the anchor cell, in CSS pixels. */
  offsetX?: number;
  offsetY?: number;
  /** Source sub-rect in image pixels; defaults to the whole image. */
  src?: { x: number; y: number; w: number; h: number };
  /** Kitty z-index. Negative paints below text, >= 0 above it. Default 0. */
  z?: number;
  /** 0..1, default 1. */
  opacity?: number;
}

interface CachedTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
}

export class ImagePass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private uRect: WebGLUniformLocation;
  private uTex: WebGLUniformLocation;
  private uResolution: WebGLUniformLocation;
  private uOpacity: WebGLUniformLocation;
  private uImage: WebGLUniformLocation;
  private vao: WebGLVertexArrayObject;
  private textures = new Map<TexImageSource, CachedTexture>();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = compileProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    const uRect = gl.getUniformLocation(this.program, 'u_rect');
    const uTex = gl.getUniformLocation(this.program, 'u_tex');
    const uResolution = gl.getUniformLocation(this.program, 'u_resolution');
    const uOpacity = gl.getUniformLocation(this.program, 'u_opacity');
    const uImage = gl.getUniformLocation(this.program, 'u_image');
    if (!uRect || !uTex || !uResolution || !uOpacity || !uImage) {
      throw new Error('webgl: image program missing uniforms');
    }
    this.uRect = uRect;
    this.uTex = uTex;
    this.uResolution = uResolution;
    this.uOpacity = uOpacity;
    this.uImage = uImage;
    // Attribute-less draw, but WebGL2 still requires a bound VAO.
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('webgl: createVertexArray failed (image pass)');
    this.vao = vao;
  }

  /**
   * Draw the placements whose z-index falls on one side of the text.
   * `cellWidth`/`cellHeight` are device pixels; `dpr` scales the CSS-pixel
   * placement offsets.
   */
  public draw(
    placements: ImagePlacement[],
    below: boolean,
    cellWidth: number,
    cellHeight: number,
    dpr: number,
    resolutionX: number,
    resolutionY: number
  ): void {
    const gl = this.gl;
    let bound = false;

    for (const placement of placements) {
      const isBelow = (placement.z ?? 0) < 0;
      if (isBelow !== below) continue;

      const cached = this.textureFor(placement.source);
      if (!cached) continue;

      if (!bound) {
        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);
        gl.uniform2f(this.uResolution, resolutionX, resolutionY);
        gl.uniform1i(this.uImage, 0);
        bound = true;
      }

      const src = placement.src ?? { x: 0, y: 0, w: cached.width, h: cached.height };
      gl.uniform4f(
        this.uRect,
        placement.col * cellWidth + (placement.offsetX ?? 0) * dpr,
        placement.row * cellHeight + (placement.offsetY ?? 0) * dpr,
        placement.cols * cellWidth,
        placement.rows * cellHeight
      );
      gl.uniform4f(
        this.uTex,
        src.x / cached.width,
        src.y / cached.height,
        src.w / cached.width,
        src.h / cached.height
      );
      gl.uniform1f(this.uOpacity, placement.opacity ?? 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cached.texture);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    if (bound) gl.bindVertexArray(null);
  }

  /** Delete textures for sources no longer referenced by any placement. */
  public retainOnly(placements: ImagePlacement[]): void {
    if (this.textures.size === 0) return;
    const live = new Set<TexImageSource>();
    for (const p of placements) live.add(p.source);
    for (const [source, cached] of this.textures) {
      if (!live.has(source)) {
        this.gl.deleteTexture(cached.texture);
        this.textures.delete(source);
      }
    }
  }

  /** Context loss invalidated every texture name. */
  public forgetTextures(): void {
    this.textures.clear();
  }

  public dispose(): void {
    for (const cached of this.textures.values()) this.gl.deleteTexture(cached.texture);
    this.textures.clear();
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
  }

  private textureFor(source: TexImageSource): CachedTexture | null {
    const hit = this.textures.get(source);
    if (hit) return hit;

    const size = sourceSize(source);
    if (!size) return null;

    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    // Scaled placements are common (an image sized to a cell box), so filter
    // linearly; NEAREST would alias badly on downscale.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const cached = { texture, width: size.width, height: size.height };
    this.textures.set(source, cached);
    return cached;
  }
}

function sourceSize(source: TexImageSource): { width: number; height: number } | null {
  const candidate = source as { width?: number; height?: number; videoWidth?: number };
  const width = candidate.videoWidth ?? candidate.width;
  const height =
    (source as { videoHeight?: number; height?: number }).videoHeight ?? candidate.height;
  if (!width || !height) return null;
  return { width, height };
}
