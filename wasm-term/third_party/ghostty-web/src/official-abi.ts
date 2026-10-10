/** WASM32 ABI, checked against the artifact's own public type manifest. */
export type OfficialExports = { memory: WebAssembly.Memory; __indirect_function_table: WebAssembly.Table } & Record<string, any>;
const manifests = new WeakMap<object, Record<string, any>>();
export function check(result: number): void {
  if (result !== 0) throw new Error(`Official libghostty-vt error ${result}`);
}
export class OfficialABI {
  readonly exports: OfficialExports;
  readonly types: Record<string, any>;
  private cachedView?: DataView;
  private cachedBytes?: Uint8Array;
  get memory(): WebAssembly.Memory { return this.exports.memory; }
  get view(): DataView {
    const buffer = this.memory.buffer;
    if (this.cachedView?.buffer !== buffer || this.cachedView.byteLength !== buffer.byteLength) this.cachedView = new DataView(buffer);
    return this.cachedView;
  }
  get bytes(): Uint8Array {
    const buffer = this.memory.buffer;
    if (this.cachedBytes?.buffer !== buffer || this.cachedBytes.byteLength !== buffer.byteLength) this.cachedBytes = new Uint8Array(buffer);
    return this.cachedBytes;
  }
  constructor(exports: WebAssembly.Exports | OfficialExports) {
    this.exports = exports as OfficialExports;
    const cached = manifests.get(exports);
    if (cached) { this.types = cached; return; }
    if (typeof this.exports.ghostty_type_json !== 'function') throw new Error('Expected official libghostty-vt WASM with type manifest');
    const ptr = this.exports.ghostty_type_json();
    const bytes = this.bytes;
    const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(ptr, bytes.indexOf(0, ptr))));
    if (manifest.abi.pointer_size !== 4 || manifest.abi.endian !== 'little') throw new Error('Unsupported Ghostty ABI');
    this.types = manifest.types;
    manifests.set(exports, this.types);
  }
  alloc(size: number): number {
    const ptr = this.exports.ghostty_wasm_alloc(size);
    if (!ptr) throw new Error('Ghostty WASM allocation failed');
    this.bytes.fill(0, ptr, ptr + size);
    return ptr;
  }
  free(ptr: number, size: number): void { this.exports.ghostty_wasm_free(ptr, size); }
  with<T>(size: number, fn: (ptr: number) => T): T {
    const ptr = this.alloc(size);
    try { return fn(ptr); } finally { this.free(ptr, size); }
  }
  create(name: string, ...args: number[]): number {
    return this.with(4, ptr => { check(this.exports[name](0, ptr, ...args)); return this.view.getUint32(ptr, true); });
  }
  sized(ptr: number, name: string): void { this.view.setUint32(ptr, this.types[name].size, true); }
  field(name: string, field: string): number { return this.types[name].fields[field].offset; }
}
// Standard WASM trampoline makes a JS callback a typed funcref for the C table.
const callbackModule = new WebAssembly.Module(new Uint8Array([
  0,97,115,109,1,0,0,0, 1,8,1,96,4,127,127,127,127,0,
  2,7,1,1,101,1,102,0,0, 7,5,1,1,102,0,0,
]));
const freeSlots = new WeakMap<WebAssembly.Table, number[]>();
export function registerWriteCallback(abi: OfficialABI, fn: (...args: number[]) => void): { index: number; dispose(): void } {
  const table = abi.exports.__indirect_function_table;
  let slots = freeSlots.get(table);
  if (!slots) freeSlots.set(table, slots = []);
  const index = slots.pop() ?? table.grow(1);
  const instance = new WebAssembly.Instance(callbackModule, { e: { f: fn } });
  table.set(index, instance.exports.f);
  return { index, dispose() { table.set(index, null); slots!.push(index); } };
}
