// The side panel's shell: open and close, and a grip on its left edge to drag it wider or
// narrower. Its width is a CSS variable, so the terminal inside simply sees its container
// change size (the display refits and the program gets a new window size).

const widthKey = 'terminal-panel-width', openKey = 'terminal-panel-open'
const stored = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const store = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* private mode */ } }

export interface Panel {
  readonly open: boolean
  setOpen(open: boolean): void
  setWidth(pixels: number): void
}

export function installPanel(options: { onOpen?(): void; /** After the panel opened or closed (not at the start). */ onChange?(open: boolean): void; /** Start closed whatever this browser remembers (`?panel=closed`). */ startClosed?: boolean; /** Leave the focus where it is on closing (the behaviour before 2026-10-11). */ keepFocus?: boolean } = {}): Panel {
  const body = document.body
  const panel = document.querySelector<HTMLElement>('#panel')!, grip = document.querySelector<HTMLElement>('#grip')!
  const clamp = (pixels: number) => Math.round(Math.max(280, Math.min(window.innerWidth - 120, pixels)))
  const setWidth = (pixels: number) => {
    if (window.innerWidth <= 700) return
    body.style.setProperty('--panel', `${clamp(pixels)}px`)
  }
  const saved = Number(stored(widthKey))
  if (saved > 0) setWidth(saved)
  let open = !options.startClosed && stored(openKey) !== '0'
  const apply = () => body.classList.toggle('closed', !open)
  apply()
  const setOpen = (next: boolean) => {
    open = next
    store(openKey, next ? '1' : '0')
    // Closing takes the focus out of the terminal: a focused field in a hidden panel keeps a
    // phone's keyboard up, and the browser may scroll the page towards it.
    if (!next && !options.keepFocus && panel.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
    apply()
    if (next) options.onOpen?.()
    options.onChange?.(next)
  }
  document.querySelector<HTMLButtonElement>('#close')!.addEventListener('click', () => setOpen(false))
  document.querySelector<HTMLButtonElement>('#open')!.addEventListener('click', () => setOpen(true))

  // Pointer capture keeps the drag on the grip even over the app's frame.
  grip.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    event.preventDefault()
    grip.setPointerCapture(event.pointerId)
    body.classList.add('dragging')
    const move = (moved: PointerEvent) => setWidth(window.innerWidth - moved.clientX)
    const end = () => {
      grip.removeEventListener('pointermove', move)
      body.classList.remove('dragging')
      store(widthKey, String(panel.getBoundingClientRect().width))
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', end, { once: true })
    grip.addEventListener('pointercancel', end, { once: true })
  })
  grip.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    setWidth(panel.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 24 : -24))
    store(widthKey, String(panel.getBoundingClientRect().width))
  })
  window.addEventListener('resize', () => { if (body.style.getPropertyValue('--panel')) setWidth(panel.getBoundingClientRect().width) })
  return { get open() { return open }, setOpen, setWidth }
}
