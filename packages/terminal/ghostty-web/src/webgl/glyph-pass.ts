/**
 * Glyph pass: one textured quad per painted cell, sampled from the atlas array
 * texture. Monochrome glyphs are coverage masks tinted by the per-instance
 * color; color glyphs (emoji) pass through.
 */

import { compileProgram } from './gl-utils';
import type { GlyphAtlas, GlyphEntry } from './glyph-atlas';
import { InstancedBuffer } from './instanced-buffer';

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec4 a_rect;   // x, y, w, h in device pixels
layout(location = 1) in vec4 a_tex;    // u, v, uw, vh normalized
layout(location = 2) in vec2 a_meta;   // atlas layer, colored flag
layout(location = 3) in vec4 a_color;  // tint rgb + alpha (faint)
uniform vec2 u_resolution;
out vec2 v_uv;
out float v_layer;
out float v_colored;
out vec4 v_color;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 pixel = a_rect.xy + corner * a_rect.zw;
  vec2 clip = pixel / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_tex.xy + corner * a_tex.zw;
  v_layer = a_meta.x;
  v_colored = a_meta.y;
  v_color = a_color;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform mediump sampler2DArray u_atlas;
in vec2 v_uv;
in float v_layer;
in float v_colored;
in vec4 v_color;
out vec4 outColor;
void main() {
  vec4 texel = texture(u_atlas, vec3(v_uv, v_layer));
  if (v_colored > 0.5) {
    // Bitmap glyph: keep its own colors, honor the instance alpha (faint).
    float a = texel.a * v_color.a;
    outColor = vec4(texel.rgb * a, a);
  } else {
    // Coverage mask: tint it.
    float coverage = texel.a * v_color.a;
    outColor = vec4(v_color.rgb * coverage, coverage);
  }
}`;

export interface GlyphProgram {
  program: WebGLProgram;
  uResolution: WebGLUniformLocation;
  uAtlas: WebGLUniformLocation;
}

export function createGlyphProgram(gl: WebGL2RenderingContext): GlyphProgram {
  const program = compileProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
  const uResolution = gl.getUniformLocation(program, 'u_resolution');
  const uAtlas = gl.getUniformLocation(program, 'u_atlas');
  if (!uResolution || !uAtlas) throw new Error('webgl: glyph program missing uniforms');
  return { program, uResolution, uAtlas };
}

const STRIDE = 14;

export class GlyphPass {
  private gl: WebGL2RenderingContext;
  private prog: GlyphProgram;
  private buffer: InstancedBuffer;

  constructor(gl: WebGL2RenderingContext, prog: GlyphProgram, capacity: number) {
    this.gl = gl;
    this.prog = prog;
    this.buffer = new InstancedBuffer(
      gl,
      [
        { location: 0, size: 4 },
        { location: 1, size: 4 },
        { location: 2, size: 2 },
        { location: 3, size: 4 },
      ],
      capacity
    );
  }

  public resize(capacity: number): void {
    this.buffer.resize(capacity);
  }

  /** Place `entry` with its cell origin at (cellX, cellY), device pixels. */
  public set(
    index: number,
    entry: GlyphEntry,
    cellX: number,
    cellY: number,
    r: number,
    g: number,
    b: number,
    a: number
  ): void {
    const d = this.buffer.data;
    const o = index * STRIDE;
    d[o] = cellX + entry.offX;
    d[o + 1] = cellY + entry.offY;
    d[o + 2] = entry.w;
    d[o + 3] = entry.h;
    d[o + 4] = entry.u;
    d[o + 5] = entry.v;
    d[o + 6] = entry.uw;
    d[o + 7] = entry.vh;
    d[o + 8] = entry.layer;
    d[o + 9] = entry.colored ? 1 : 0;
    d[o + 10] = r;
    d[o + 11] = g;
    d[o + 12] = b;
    d[o + 13] = a;
    this.buffer.markDirty(index);
  }

  public clear(index: number): void {
    this.buffer.clearInstance(index);
  }

  public clearAll(): void {
    this.buffer.clearAll();
  }

  public draw(
    atlas: GlyphAtlas,
    resolutionX: number,
    resolutionY: number,
    offset = 0,
    count?: number
  ): void {
    const gl = this.gl;
    this.buffer.flush();
    gl.useProgram(this.prog.program);
    gl.uniform2f(this.prog.uResolution, resolutionX, resolutionY);
    atlas.bind(0);
    gl.uniform1i(this.prog.uAtlas, 0);
    this.buffer.draw(offset, count ?? this.buffer.instanceCapacity - offset);
  }

  public dispose(): void {
    this.buffer.dispose();
  }
}
