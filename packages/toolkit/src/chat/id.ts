// Message ids minted by this client, so a prompt has its identity before the server has
// seen it: the optimistic row, the request, the `session.inbox.*` events and the persisted
// message all carry the same id, and sending the same id twice admits it once.
//
// `ascending` is OpenCode 2.0.26's (`packages/schema/src/identifier.ts`, MIT, see
// ../../NOTICES.md): 48 bits of millisecond time and a 12-bit counter, hex, then random
// base62, so ids sort by creation.
const length = 26;
const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastTimestamp = 0;
let counter = 0;

export function ascending(timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  const value = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, '0')).join('');
  const bytes = crypto.getRandomValues(new Uint8Array(length - 12));
  return time + Array.from(bytes, byte => chars[byte % 62]).join('');
}
export const messageID = () => `msg_${ascending()}`;
