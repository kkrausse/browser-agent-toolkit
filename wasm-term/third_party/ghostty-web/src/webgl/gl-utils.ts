/**
 * Minimal WebGL2 helpers: program compilation and instance-attribute wiring.
 */

export function compileProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('webgl: createProgram failed');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // Shaders are linked into the program; the objects themselves are dead now.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`webgl: program link failed: ${log}`);
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('webgl: createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`webgl: shader compile failed: ${log}\n${source}`);
  }
  return shader;
}

export interface AttributeSpec {
  location: number;
  /** Number of floats. */
  size: number;
}

/**
 * Bind `buffer` as a per-instance source for `attrs`, packed in declaration
 * order into a float stride.
 *
 * Quad corners come from gl_VertexID in the vertex shaders, so instance data is
 * the only vertex buffer any pass needs.
 */
export function bindInstanceAttributes(
  gl: WebGL2RenderingContext,
  buffer: WebGLBuffer,
  attrs: AttributeSpec[],
  baseOffsetBytes = 0
): void {
  const stride = attrs.reduce((n, a) => n + a.size, 0) * 4;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  let offset = baseOffsetBytes;
  for (const attr of attrs) {
    gl.enableVertexAttribArray(attr.location);
    gl.vertexAttribPointer(attr.location, attr.size, gl.FLOAT, false, stride, offset);
    gl.vertexAttribDivisor(attr.location, 1);
    offset += attr.size * 4;
  }
}
