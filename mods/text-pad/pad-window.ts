import { clampFrame, firstFrame, frameOf, type Frame, type Viewport } from './window-frame.js'

const STORE_KEY = 'seti.text-pad.window'

interface WindowState {
  open: boolean
  frame: Frame | null
}

function read(): WindowState {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')
    const saved = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
    return { open: saved.open === true, frame: frameOf(saved.frame) }
  } catch {
    return { open: false, frame: null }
  }
}

const viewport = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight })

/** Whether this device shows the pad's window and where; each device keeps its own. */
export class PadWindowState {
  private state: WindowState = read()
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly isOpen = () => this.state.open

  /** Where the window sits now, fitted into the viewport as it is. */
  frame(): Frame {
    const view = viewport()
    return clampFrame(this.state.frame ?? firstFrame(view), view)
  }

  setOpen(open: boolean): void {
    this.save({ ...this.state, open })
  }

  setFrame(frame: Frame): void {
    this.save({ ...this.state, frame: clampFrame(frame, viewport()) })
  }

  private save(next: WindowState): void {
    this.state = next
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next))
    } catch {
      // Without storage the window keeps its place for this page only.
    }
    for (const listener of this.listeners) {
      listener()
    }
  }
}
