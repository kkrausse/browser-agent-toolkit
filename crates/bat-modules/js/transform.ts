// The module transform, compiled to WebAssembly, for files that were not
// transformed at prepare time (workspace sources). Synchronous once the
// module is instantiated.
//
//   const transform = await createTransform(wasmBytesOrModule);
//   const out = transform(source, "/workspace/src/app.tsx", { packageType: "module" });
//   if (!out.ok) throw new SyntaxError(out.diagnostics[0].message);
//   out.code   // function body, see docs/design/module-format.md
//   out.facts  // kind, async, imports, exports, ...

import { decodeFacts, type Facts } from "./facts.ts";

export interface TransformOptions {
  /** `type` of the nearest package.json. */
  packageType?: "module" | "commonjs";
  /** Override extension, package type and syntax detection. */
  forceKind?: "cjs" | "esm" | "json";
  /** Ask for a source map (only produced for TypeScript/JSX). */
  sourceMap?: boolean;
  /** tsconfig `jsx`. `preserve` is treated as `react-jsx`. */
  jsx?: "react-jsx" | "react-jsxdev" | "react" | "preserve";
  jsxImportSource?: string;
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  verbatimModuleSyntax?: boolean;
  experimentalDecorators?: boolean;
  emitDecoratorMetadata?: boolean;
  useDefineForClassFields?: boolean;
  /** Replacement for `import(` (default `__bat.import`). */
  dynamicImport?: string;
}

export interface Diagnostic {
  severity: "error" | "warning";
  line: number;
  column: number;
  message: string;
}

export interface TransformResult {
  ok: boolean;
  /** Function body. Empty when `ok` is false. */
  code: string;
  facts: Facts;
  /** Source map JSON, when requested and produced. */
  map?: string;
  diagnostics: Diagnostic[];
}

export type Transform = (source: string, filename: string, options?: TransformOptions) => TransformResult;

interface Exports {
  memory: WebAssembly.Memory;
  bat_alloc(length: number): number;
  bat_free(pointer: number, length: number): void;
  bat_transform(src: number, srcLen: number, name: number, nameLen: number, opts: number, optsLen: number): number;
  bat_result_free(result: number): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeOptions(options: TransformOptions): Uint8Array {
  let flags = 0;
  if (options.packageType === "commonjs") flags |= 1;
  if (options.packageType === "module") flags |= 2;
  if (options.forceKind) flags |= { cjs: 1, esm: 2, json: 3 }[options.forceKind] << 2;
  if (options.sourceMap) flags |= 1 << 4;
  if (options.jsx === "react-jsxdev") flags |= 1 << 5;
  if (options.jsx === "react") flags |= 2 << 5;
  if (options.verbatimModuleSyntax) flags |= 1 << 7;
  if (options.experimentalDecorators) flags |= 1 << 8;
  if (options.emitDecoratorMetadata) flags |= 1 << 9;
  if (options.useDefineForClassFields === false) flags |= 1 << 10;
  const strings = [options.jsxImportSource, options.jsxFactory, options.jsxFragmentFactory, options.dynamicImport].map(
    (text) => encoder.encode(text ?? ""),
  );
  const bytes = new Uint8Array(4 + strings.reduce((sum, s) => sum + 4 + s.length, 0));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, flags, true);
  let pos = 4;
  for (const text of strings) {
    view.setUint32(pos, text.length, true);
    bytes.set(text, pos + 4);
    pos += 4 + text.length;
  }
  return bytes;
}

/**
 * Instantiate the transform. One instance is single-threaded state: give each
 * worker its own. If a call throws a WebAssembly.RuntimeError (the Rust side
 * aborted), discard the instance and create a new one.
 */
export async function createTransform(wasm: BufferSource | WebAssembly.Module): Promise<Transform> {
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const instance = await WebAssembly.instantiate(module, {});
  const wasmExports = instance.exports as unknown as Exports;

  // Copy bytes into Wasm memory; returns [pointer, length].
  const put = (bytes: Uint8Array): [number, number] => {
    const pointer = wasmExports.bat_alloc(bytes.length);
    new Uint8Array(wasmExports.memory.buffer, pointer, bytes.length).set(bytes);
    return [pointer, bytes.length];
  };

  return (source, filename, options = {}) => {
    // Worst case three bytes per UTF-16 unit; encodeInto avoids a second copy.
    const capacity = source.length * 3;
    const srcPointer = wasmExports.bat_alloc(capacity);
    const srcLength = encoder.encodeInto(source, new Uint8Array(wasmExports.memory.buffer, srcPointer, capacity)).written;
    const [namePointer, nameLength] = put(encoder.encode(filename));
    const [optsPointer, optsLength] = put(encodeOptions(options));
    const result = wasmExports.bat_transform(srcPointer, srcLength, namePointer, nameLength, optsPointer, optsLength);
    try {
      // Memory may have grown during the call: take the buffer again.
      const buffer = wasmExports.memory.buffer;
      const header = new Uint32Array(buffer, result, 10);
      const text = (pointer: number, length: number) => decoder.decode(new Uint8Array(buffer, pointer, length));
      const facts = decodeFacts(header[1], new Uint8Array(buffer, header[4], header[5]));
      const diagnostics: Diagnostic[] = [];
      if (header[9] > 0) {
        for (const line of text(header[8], header[9]).split("\n")) {
          if (!line) continue;
          const [severity, lineNumber, column, ...message] = line.split("\t");
          diagnostics.push({
            severity: severity === "E" ? "error" : "warning",
            line: Number(lineNumber),
            column: Number(column),
            message: message.join("\t"),
          });
        }
      }
      return {
        ok: header[0] === 1,
        code: text(header[2], header[3]),
        facts,
        map: header[7] > 0 ? text(header[6], header[7]) : undefined,
        diagnostics,
      };
    } finally {
      wasmExports.bat_result_free(result);
      wasmExports.bat_free(srcPointer, capacity);
      wasmExports.bat_free(namePointer, nameLength);
      wasmExports.bat_free(optsPointer, optsLength);
    }
  };
}
