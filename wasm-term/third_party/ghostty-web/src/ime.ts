/**
 * Cursor-local preedit and a real textarea caret box for the platform IME.
 * Follows the presentation approach discussed in coder/ghostty-web#190.
 * Presentation only: InputHandler is the sole owner of committed input.
 */
export class ImeOverlay {
  private overlay: HTMLSpanElement;
  private composing = false;
  private start = () => {
    this.composing = true;
    this.sync();
  };
  private update = (event: CompositionEvent) => {
    this.overlay.textContent = event.data;
    this.sync();
  };
  private end = () => {
    this.composing = false;
    this.overlay.textContent = '';
    this.overlay.style.display = 'none';
    this.textarea.value = '';
  };

  constructor(
    private textarea: HTMLTextAreaElement,
    private sync: () => void
  ) {
    this.overlay = document.createElement('span');
    this.overlay.setAttribute('aria-hidden', 'true');
    Object.assign(this.overlay.style, {
      position: 'absolute', pointerEvents: 'none', whiteSpace: 'pre',
      textDecoration: 'underline', display: 'none', zIndex: '1',
    });
    textarea.parentElement!.appendChild(this.overlay);
    textarea.addEventListener('compositionstart', this.start);
    textarea.addEventListener('compositionupdate', this.update);
    textarea.addEventListener('compositionend', this.end);
    textarea.addEventListener('blur', this.end);
  }

  position(options: {
    left: number; top: number; width: number; height: number;
    fontFamily: string; fontSize: number; foreground: string; background: string;
    visible: boolean;
  }): void {
    const { left, top, width, height, fontFamily, fontSize, foreground, background, visible } = options;
    const style = {
      left: `${left}px`, top: `${top}px`, height: `${height}px`,
      fontFamily, fontSize: `${fontSize}px`, lineHeight: `${height}px`,
    };
    // SelectionManager temporarily borrows this input for the native copy menu.
    if (this.textarea.style.position !== 'fixed') {
      // iOS zooms focused form controls below 16 CSS px. This is a hidden
      // input, so keep its font independent of the visible terminal/preedit.
      // Apply on every cursor update, not just once when mobile controls mount.
      Object.assign(this.textarea.style, style, {
        width: `${width}px`, fontSize: `${Math.max(16, fontSize)}px`,
      });
    }
    Object.assign(this.overlay.style, style, {
      color: foreground, backgroundColor: background,
      display: this.composing && visible ? 'block' : 'none',
    });
  }

  dispose(): void {
    this.textarea.removeEventListener('compositionstart', this.start);
    this.textarea.removeEventListener('compositionupdate', this.update);
    this.textarea.removeEventListener('compositionend', this.end);
    this.textarea.removeEventListener('blur', this.end);
    this.overlay.remove();
  }
}
