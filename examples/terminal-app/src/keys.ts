// The keys a phone's keyboard lacks, as a row under the terminal: Esc, a sticky Ctrl, Tab, the
// arrows and Enter, and a button that raises or drops the keyboard. Shown where the pointer is
// coarse (index.html). After `random/bun-web-terminal/src/mobile.ts` (same author), without its
// dictation, paste and attach.
//
// A press is a `keydown` dispatched at the terminal, so the terminal encodes it as it would a
// hardware key (the arrows follow the program's cursor-key mode). Ctrl is held for one key:
// one of the row's, or the next character typed on the keyboard, which `input` turns into its
// control code (ctrl+p is 0x10).

const icons = {
  // Lucide icons (ISC): keyboard, corner-down-left.
  Keyboard: '<rect width="20" height="14" x="2" y="5" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 17h8"/>',
  Enter: '<path d="m9 10-5 5 5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
}
const keys = [
  ['Keyboard', 'Keyboard'], ['Escape', 'Esc'], ['Control', 'Ctrl'], ['Tab', 'Tab'],
  ['ArrowLeft', '←'], ['ArrowDown', '↓'], ['ArrowUp', '↑'], ['ArrowRight', '→'], ['Enter', 'Enter'],
] as const

export interface Keys {
  /** What the keyboard typed, as it goes to the program: with Ctrl held, one character becomes its control code. */
  input(data: string): string
  /** Where the presses go: the terminal's own input element once it is mounted. */
  attach(target: { textarea?: HTMLElement; focus(): void }): void
}

export function installKeys(container: HTMLElement): Keys {
  const toolbar = document.createElement('div')
  toolbar.id = 'keys'
  toolbar.setAttribute('role', 'group')
  toolbar.setAttribute('aria-label', 'Terminal extra keys')
  for (const [key, label] of keys) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.key = key
    button.title = label
    button.setAttribute('aria-label', key.replace('Arrow', 'Arrow '))
    if (key in icons) button.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[key as keyof typeof icons]}</svg>`
    else button.textContent = label
    if (key === 'Control') button.setAttribute('aria-pressed', 'false')
    toolbar.append(button)
  }
  container.after(toolbar)

  let target: { textarea?: HTMLElement; focus(): void } | undefined
  let control = false
  const setControl = (value: boolean) => {
    control = value
    toolbar.querySelector('[data-key="Control"]')!.setAttribute('aria-pressed', String(value))
  }
  // A press must not take the focus from the terminal: that would drop the keyboard.
  // With that default prevented not every engine follows the touch with a click, so the press
  // is the pointer's release over the button it went down on; a click that does come after it
  // is the same press, and one that comes alone is a keyboard's or a screen reader's.
  const keyOf = (event: Event) => (event.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.key
  let down: string | undefined, released = 0
  toolbar.addEventListener('pointerdown', event => { event.preventDefault(); down = keyOf(event) })
  toolbar.addEventListener('pointerup', event => {
    const key = keyOf(event)
    if (key && key === down) { released = event.timeStamp; press(key) }
    down = undefined
  })
  toolbar.addEventListener('click', event => {
    const key = keyOf(event)
    if (key && event.timeStamp - released > 700) press(key)
  })
  function press(key: string) {
    if (!target) return
    if (key === 'Keyboard') {
      if (container.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
      else target.focus()
      return
    }
    if (key === 'Control') { setControl(!control); return }
    const ctrlKey = control
    setControl(false)
    ;(target.textarea ?? container).dispatchEvent(new KeyboardEvent('keydown', { key, code: key, ctrlKey, bubbles: true, cancelable: true }))
  }
  window.addEventListener('blur', () => setControl(false))

  // The keyboard covers the bottom of the page without resizing it; the visual viewport is
  // what is left, so the page takes its height and place and the row sits on the keyboard.
  const viewport = window.visualViewport
  if (viewport && matchMedia('(any-pointer: coarse)').matches) {
    document.body.classList.add('keys')
    let frame = 0
    const layout = () => {
      frame = 0
      // Unzoomed CSS pixels: a pinch zoom must not resize the terminal.
      document.body.style.height = `${viewport.height * viewport.scale}px`
      document.body.style.top = `${Math.abs(viewport.scale - 1) < 0.01 ? viewport.offsetTop : 0}px`
    }
    const schedule = () => { frame ||= requestAnimationFrame(layout) }
    viewport.addEventListener('resize', schedule)
    viewport.addEventListener('scroll', schedule)
    window.addEventListener('pageshow', schedule)
    layout()
  }

  return {
    input(data) {
      if (!control) return data
      setControl(false)
      const code = data.length === 1 ? data.toUpperCase().charCodeAt(0) : 0
      return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code & 0x1f) : data
    },
    attach(mounted) { target = mounted },
  }
}
