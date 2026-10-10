import { OfficialABI, check, type OfficialExports } from './official-abi';
import { type KeyEvent, type KittyKeyFlags, KeyEncoderOption } from './types';
export class KeyEncoder {
  private abi: OfficialABI;
  private handle: number;
  constructor(exports: WebAssembly.Exports | OfficialExports) {
    this.abi = new OfficialABI(exports);
    this.handle = this.abi.create('ghostty_key_encoder_new');
  }
  setOption(option: KeyEncoderOption, value: boolean | number): void {
    this.alive();
    this.abi.with(4, ptr => {
      this.abi.view.setUint32(ptr, Number(value), true);
      this.abi.exports.ghostty_key_encoder_setopt(this.handle, option, ptr);
    });
  }
  setKittyFlags(flags: KittyKeyFlags): void { this.setOption(KeyEncoderOption.KITTY_KEYBOARD_FLAGS, flags); }
  setTerminal(terminal: { syncKeyEncoder(encoder: KeyEncoder): void }): void { terminal.syncKeyEncoder(this); }
  syncFromTerminal(handle: number): void { this.alive(); this.abi.exports.ghostty_key_encoder_setopt_from_terminal(this.handle, handle); }
  encode(event: KeyEvent): Uint8Array {
    this.alive();
    const a = this.abi, e = a.exports;
    const key = a.create('ghostty_key_event_new');
    const text = new TextEncoder().encode(event.utf8 ?? '');
    let ptr = 0;
    try {
      if (text.length) ptr = a.alloc(text.length);
      e.ghostty_key_event_set_action(key, event.action);
      // Official Ghostty added FN at 146; retain the public bridge's older
      // numeric enum while mapping FN_LOCK and subsequent keys to the C ABI.
      e.ghostty_key_event_set_key(key, event.key >= 146 ? event.key + 1 : event.key);
      e.ghostty_key_event_set_mods(key, event.mods);
      e.ghostty_key_event_set_consumed_mods(key, event.consumedMods ?? 0);
      e.ghostty_key_event_set_composing(key, event.composing ? 1 : 0);
      e.ghostty_key_event_set_unshifted_codepoint(key, event.unshiftedCodepoint ?? 0);
      if (ptr) { a.bytes.set(text, ptr); e.ghostty_key_event_set_utf8(key, ptr, text.length); }
      return a.with(4, written => {
        const result = e.ghostty_key_encoder_encode(this.handle, key, 0, 0, written);
        if (result !== 0 && result !== -3) check(result);
        const size = a.view.getUint32(written, true);
        if (!size) return new Uint8Array();
        return a.with(size, out => {
          check(e.ghostty_key_encoder_encode(this.handle, key, out, size, written));
          return a.bytes.slice(out, out + a.view.getUint32(written, true));
        });
      });
    } finally { if (ptr) a.free(ptr, text.length); e.ghostty_key_event_free(key); }
  }
  private alive(): void { if (!this.handle) throw new Error('Key encoder has been disposed'); }
  dispose(): void { if (this.handle) { this.abi.exports.ghostty_key_encoder_free(this.handle); this.handle = 0; } }
}
