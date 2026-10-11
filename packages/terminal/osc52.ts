// OSC 52, the escape sequence by which a program on a terminal sets the user's clipboard:
//
//   ESC ] 52 ; <selection letters> ; <base64 of the text> (BEL | ESC \)
//
// ghostty-web's core parses the sequence and does nothing with it, so the display watches the
// program's output for it (display.ts). Only writes are served: a query (`?` as the payload)
// would hand the clipboard's contents to whatever runs on the terminal, and is ignored, as is
// an empty payload (a clear).

const intro = [0x1b, 0x5d, 0x35, 0x32, 0x3b]; // ESC ] 5 2 ;
/** Longer than this (base64 characters) is not a clipboard write worth keeping in memory. */
const limit = 8 << 20;

/** Returns a function to pass every chunk of output through; `onText` is called once per complete OSC 52 write.
 * A sequence may be split across chunks anywhere. */
export function clipboardWrites(onText: (text: string) => void): (data: Uint8Array) => void {
  // How many bytes of `intro` have matched, then, inside a sequence, what follows it so far.
  let matched = 0;
  let body: number[] | undefined;
  let escape = false;

  function finish(): void {
    const bytes = body!;
    body = undefined;
    escape = false;
    matched = 0;
    const semicolon = bytes.indexOf(0x3b);
    if (semicolon < 0) return;
    const payload = new TextDecoder("latin1").decode(Uint8Array.from(bytes.slice(semicolon + 1)));
    if (!payload || payload === "?") return;
    let text: string;
    try {
      text = new TextDecoder().decode(Uint8Array.from(atob(payload), char => char.charCodeAt(0)));
    } catch {
      return; // not base64
    }
    if (text) onText(text);
  }

  return data => {
    for (const byte of data) {
      if (body) {
        if (escape) {
          // ESC \ ends it; ESC anything else is not part of an OSC: drop what was collected.
          if (byte === 0x5c) finish();
          else { body = undefined; escape = false; matched = byte === intro[0] ? 1 : 0; }
        } else if (byte === 0x07) finish();
        else if (byte === 0x1b) escape = true;
        else if (body.length >= limit) { body = undefined; matched = 0; }
        else body.push(byte);
      } else if (byte === intro[matched]) {
        if (++matched === intro.length) body = [];
      } else matched = byte === intro[0] ? 1 : 0;
    }
  };
}
