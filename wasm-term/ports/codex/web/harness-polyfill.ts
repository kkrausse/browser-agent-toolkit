// Bun has no WebAssembly.compileStreaming; host/worker.ts uses it.
if (typeof WebAssembly.compileStreaming !== "function") {
  WebAssembly.compileStreaming = async source => WebAssembly.compile(await (await source).arrayBuffer());
}
