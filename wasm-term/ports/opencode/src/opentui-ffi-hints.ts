// OpenTUI functions of the shape `fn(handle, out: [*]u8, max_len: usize) usize`:
// they fill a caller-supplied buffer and return the number of bytes written.
// OpenTUI hands them large scratch buffers (the prompt's text is read into a
// 1 MiB one several times per keystroke), so copying the whole buffer into
// linear memory and back, the default for a "ptr" argument, was 2 MiB of
// memcpy per call: measured 15 MB/s copied in while typing. With these hints
// nothing is copied in and only the written bytes come back.
//
// Each entry was checked against its call site in vendor/opentui
// packages/core/src/zig.ts (the result is used as the written length).
import type { FfiHint } from "./wasm-ffi"

export const OPENTUI_FFI_HINTS: Record<string, FfiHint> = {
  bufferGetId: { out: 1 },
  linkGetUrl: { out: 1 },
  textBufferGetPlainText: { out: 1 },
  textBufferViewGetSelectedText: { out: 1 },
  textBufferViewGetPlainText: { out: 1 },
  editBufferGetText: { out: 1 },
  editBufferUndo: { out: 1 },
  editBufferRedo: { out: 1 },
  editorViewGetSelectedTextBytes: { out: 1 },
  editorViewGetText: { out: 1 },
}
