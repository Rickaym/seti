import type { Terminal } from '@xterm/xterm'
import { spanBetween, wordAt, type Cell } from './terminal-select'

/** A finger held this long without moving selects the word under it. */
const LONG_PRESS_MS = 450
/** A finger that moves further than this before then scrolls or taps instead. */
const SLOP_PX = 8
const PRESS_BUZZ_MS = 12

/** The buffer cell under a point on the terminal's screen. */
function cellAt(term: Terminal, x: number, y: number): Cell | null {
  const screen = term.element?.querySelector('.xterm-screen')
  if (screen === null || screen === undefined || term.cols === 0 || term.rows === 0) {
    return null
  }
  const box = screen.getBoundingClientRect()
  const col = Math.floor(((x - box.left) / box.width) * term.cols)
  const row = Math.floor(((y - box.top) / box.height) * term.rows)
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max - 1)
  return { col: clamp(col, term.cols), row: term.buffer.active.viewportY + clamp(row, term.rows) }
}

/**
 * Selects text with a finger as a phone app does: a long press selects the word under it and a
 * drag that follows extends the selection. `onSelected` hears the text once the finger lifts.
 * Its listeners run before the touch scrolling's and keep a selecting drag from scrolling, and a
 * lift that ends a selection never taps the terminal into focus. Returns the teardown.
 */
export function selectByTouch(term: Terminal, host: HTMLElement, onSelected: (text: string) => void): () => void {
  let timer: number | undefined
  let start: { x: number; y: number } | null = null
  let anchor: Cell | null = null

  const cancel = () => {
    window.clearTimeout(timer)
    timer = undefined
    start = null
  }
  const press = () => {
    timer = undefined
    const cell = start === null ? null : cellAt(term, start.x, start.y)
    if (cell === null) {
      return
    }
    const line = term.buffer.active.getLine(cell.row)?.translateToString(true)
    const word = line === undefined ? null : wordAt(line, cell.col)
    const from = word === null ? cell : { col: word.start, row: cell.row }
    anchor = from
    term.select(from.col, from.row, word?.length ?? 1)
    if ('vibrate' in navigator) {
      navigator.vibrate(PRESS_BUZZ_MS)
    }
  }

  const onStart = (event: TouchEvent) => {
    cancel()
    anchor = null
    const touch = event.touches.length === 1 ? event.touches[0] : undefined
    if (touch !== undefined) {
      start = { x: touch.clientX, y: touch.clientY }
      timer = window.setTimeout(press, LONG_PRESS_MS)
    }
  }
  const onMove = (event: TouchEvent) => {
    const touch = event.touches[0]
    if (anchor !== null && touch !== undefined) {
      event.preventDefault()
      event.stopPropagation()
      const focus = cellAt(term, touch.clientX, touch.clientY)
      if (focus !== null) {
        const span = spanBetween(anchor, focus, term.cols)
        term.select(span.col, span.row, span.length)
      }
      return
    }
    if (start !== null && touch !== undefined) {
      const moved = Math.hypot(touch.clientX - start.x, touch.clientY - start.y)
      if (moved > SLOP_PX) {
        cancel()
      }
    }
  }
  const onEnd = (event: TouchEvent) => {
    cancel()
    if (anchor === null) {
      return
    }
    anchor = null
    event.preventDefault()
    event.stopPropagation()
    if (term.hasSelection()) {
      onSelected(term.getSelection())
    }
  }
  // Android opens its own menu on a long press; the terminal's selection replaces it.
  const onMenu = (event: Event) => {
    if (event.target instanceof Node && term.element?.contains(event.target) === true && term.hasSelection()) {
      event.preventDefault()
    }
  }

  host.addEventListener('touchstart', onStart, { capture: true, passive: true })
  host.addEventListener('touchmove', onMove, { capture: true, passive: false })
  host.addEventListener('touchend', onEnd, { capture: true, passive: false })
  host.addEventListener('touchcancel', cancel, { capture: true })
  host.addEventListener('contextmenu', onMenu, { capture: true })
  return () => {
    cancel()
    host.removeEventListener('touchstart', onStart, { capture: true })
    host.removeEventListener('touchmove', onMove, { capture: true })
    host.removeEventListener('touchend', onEnd, { capture: true })
    host.removeEventListener('touchcancel', cancel, { capture: true })
    host.removeEventListener('contextmenu', onMenu, { capture: true })
  }
}
