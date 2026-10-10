/**
 * Solid-rect pass: cell backgrounds, selection, underline/strikethrough,
 * cursor, scrollbar. One instance per rect, one draw call per batch.
 */

import { compileProgram } from './gl-utils';
import { InstancedBuffer } from './instanced-buffer';

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec4 a_rect;   // x, y, w, h in device pixels
layout(location = 1) in vec4 a_color;  // straight-alpha rgba, 0..1
uniform vec2 u_resolution;
out vec4 v_color;
void main() {
  // Unit-quad corner from the vertex index: TRIANGLE_STRIP over 4 vertices.
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 pixel = a_rect.xy + corner * a_rect.zw;
  vec2 clip = pixel / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() {
  // Premultiplied output; the pass blends with (ONE, ONE_MINUS_SRC_ALPHA).
  outColor = vec4(v_color.rgb * v_color.a, v_color.a);
}`;

export interface RectProgram {
  program: WebGLProgram;
  uResolution: WebGLUniformLocation;
}

export function createRectProgram(gl: WebGL2RenderingContext): RectProgram {
  const program = compileProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
  const uResolution = gl.getUniformLocation(program, 'u_resolution');
  if (!uResolution) throw new Error('webgl: rect program missing u_resolution');
  return { program, uResolution };
}

export class RectPass {
  private gl: WebGL2RenderingContext;
  private prog: RectProgram;
  private buffer: InstancedBuffer;

  constructor(gl: WebGL2RenderingContext, prog: RectProgram, capacity: number) {
    this.gl = gl;
    this.prog = prog;
    this.buffer = new InstancedBuffer(
      gl,
      [
        { location: 0, size: 4 },
        { location: 1, size: 4 },
      ],
      capacity
    );
  }

  public get capacity(): number {
    return this.buffer.instanceCapacity;
  }

  public resize(capacity: number): void {
    this.buffer.resize(capacity);
  }

  public set(
    index: number,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    g: number,
    b: number,
    a: number
  ): void {
    const d = this.buffer.data;
    const o = index * 8;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = w;
    d[o + 3] = h;
    d[o + 4] = r;
    d[o + 5] = g;
    d[o + 6] = b;
    d[o + 7] = a;
    this.buffer.markDirty(index);
  }

  public clear(index: number): void {
    this.buffer.clearInstance(index);
  }

  public clearAll(): void {
    this.buffer.clearAll();
  }

  public draw(resolutionX: number, resolutionY: number, offset = 0, count?: number): void {
    const gl = this.gl;
    this.buffer.flush();
    gl.useProgram(this.prog.program);
    gl.uniform2f(this.prog.uResolution, resolutionX, resolutionY);
    this.buffer.draw(offset, count ?? this.buffer.instanceCapacity - offset);
  }

  public dispose(): void {
    this.buffer.dispose();
  }
}
