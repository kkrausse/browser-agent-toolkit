/** Decode across chunk boundaries, keeping at most 6KB of a pending output line. */
export function createProcessOutput(write: (text: string) => void) {
  const decoder = new TextDecoder();
  let pending = '';
  const accept = (text: string) => {
    pending += text;
    const end = pending.lastIndexOf('\n');
    if (end >= 0) {
      write(pending.slice(0, end + 1).slice(-6000));
      pending = pending.slice(end + 1);
    }
    pending = pending.slice(-6000);
  };
  return {
    push(bytes: Uint8Array) { accept(decoder.decode(bytes, { stream: true })); },
    flush() { accept(decoder.decode()); if (pending) write(pending); pending = ''; },
  };
}
