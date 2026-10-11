/**
 * A growable per-instance float buffer with dirty-range upload.
 *
 * Instance slots are addressed by index and stay put across frames — one slot
 * per cell — so an unchanged row costs nothing: no rewrite, no upload. Unused
 * slots keep zero width and are discarded by the rasterizer.
 */

import { type AttributeSpec, bindInstanceAttributes } from './gl-utils';

export class InstancedBuffer {
  private gl: WebGL2RenderingContext;
  /** Floats per instance. */
  public readonly stride: number;
  public data: Float32Array;
  private buffer: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private attrs: AttributeSpec[];
  private capacity: number;

  private dirtyMin = Number.POSITIVE_INFINITY;
  private dirtyMax = -1;

  constructor(gl: WebGL2RenderingContext, attrs: AttributeSpec[], capacity: number) {
    this.gl = gl;
    this.attrs = attrs;
    this.stride = attrs.reduce((n, a) => n + a.size, 0);
    this.capacity = Math.max(1, capacity);
    this.data = new Float32Array(this.capacity * this.stride);

    const buffer = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (!buffer || !vao) throw new Error('webgl: buffer/VAO allocation failed');
    this.buffer = buffer;
    this.vao = vao;
    this.allocate();
  }

  public get instanceCapacity(): number {
    return this.capacity;
  }

  /** Reallocate for a new instance count; contents are dropped. */
  public resize(capacity: number): void {
    const next = Math.max(1, capacity);
    if (next === this.capacity) {
      this.clearAll();
      return;
    }
    this.capacity = next;
    this.data = new Float32Array(this.capacity * this.stride);
    this.allocate();
  }

  /** Zero a slot so it rasterizes nothing. */
  public clearInstance(index: number): void {
    const base = index * this.stride;
    this.data.fill(0, base, base + this.stride);
    this.markDirty(index);
  }

  public clearAll(): void {
    this.data.fill(0);
    this.dirtyMin = 0;
    this.dirtyMax = this.capacity - 1;
  }

  public markDirty(index: number): void {
    if (index < this.dirtyMin) this.dirtyMin = index;
    if (index > this.dirtyMax) this.dirtyMax = index;
  }

  public markRangeDirty(from: number, to: number): void {
    if (from < this.dirtyMin) this.dirtyMin = from;
    if (to > this.dirtyMax) this.dirtyMax = to;
  }

  /** Push only the instances written since the last flush. */
  public flush(): void {
    if (this.dirtyMax < 0) return;
    const gl = this.gl;
    const from = Math.max(0, this.dirtyMin) * this.stride;
    const to = Math.min(this.capacity - 1, this.dirtyMax) * this.stride + this.stride;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, from * 4, this.data, from, to - from);
    this.dirtyMin = Number.POSITIVE_INFINITY;
    this.dirtyMax = -1;
  }

  /**
   * Draw an instance range as unit quads; corners come from gl_VertexID, so
   * instance data is the only vertex buffer bound.
   *
   * WebGL2 has no baseInstance, so a non-zero offset is expressed by pointing
   * the attributes at a byte offset into the same buffer.
   */
  public draw(offset = 0, count = this.capacity): void {
    if (count <= 0) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    if (offset !== 0) {
      bindInstanceAttributes(gl, this.buffer, this.attrs, offset * this.stride * 4);
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    if (offset !== 0) {
      bindInstanceAttributes(gl, this.buffer, this.attrs, 0);
    }
    gl.bindVertexArray(null);
  }

  public dispose(): void {
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteVertexArray(this.vao);
  }

  private allocate(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    bindInstanceAttributes(gl, this.buffer, this.attrs);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    this.dirtyMin = Number.POSITIVE_INFINITY;
    this.dirtyMax = -1;
  }
}
