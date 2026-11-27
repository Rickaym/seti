/** How long typing pauses before the pad saves. */
export const SAVE_DELAY_MS = 700

/** Waits between tries after a failed save, the last one repeating until a save works. */
const RETRY_MS = [2_000, 5_000, 15_000, 30_000]

export interface PadState {
  text: string
  /** False until the first load, so nothing typed before it can overwrite the server's text. */
  ready: boolean
  /** Why the last save or load failed, until one works again. */
  failure: string | null
}

export interface PadDeps {
  load: () => Promise<string>
  save: (text: string) => Promise<void>
  /** Text a failed save left behind in this browser, kept until a save works. */
  backup: { read: () => string | null; write: (text: string | null) => void }
  errorText: (error: unknown) => string
}

/**
 * The pad's text on this device. It saves a short while after typing stops and when asked to
 * flush, retries a failed save until it works while keeping the text in this browser, and takes
 * the server's text on refresh only while nothing typed here waits to be saved.
 */
export class PadStore {
  private state: PadState = { text: '', ready: false, failure: null }
  /** The text the server is known to hold. */
  private saved = ''
  private saving = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private retries = 0
  private disposed = false
  private readonly listeners = new Set<() => void>()

  private readonly deps: PadDeps

  constructor(deps: PadDeps) {
    this.deps = deps
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly get = () => this.state

  /** Takes the server's text unless this device has typing it has not saved yet. */
  async refresh(): Promise<void> {
    if (this.saving) {
      return
    }
    try {
      const server = await this.deps.load()
      if (!this.state.ready) {
        this.first(server)
      } else if (!this.pending()) {
        this.saved = server
        this.set({ text: server })
      }
    } catch (error) {
      if (!this.state.ready) {
        this.set({ failure: this.deps.errorText(error) })
        this.schedule(RETRY_MS[1] ?? SAVE_DELAY_MS, async () => this.refresh())
      }
    }
  }

  edit(text: string): void {
    if (!this.state.ready) {
      return
    }
    this.set({ text })
    this.deps.backup.write(text)
    this.schedule(SAVE_DELAY_MS)
  }

  /** Saves now what waits to be saved, as when the pad loses focus or the page hides. */
  async flush(): Promise<void> {
    const text = this.state.text
    if (this.saving || !this.state.ready || text === this.saved) {
      return
    }
    this.clearTimer()
    this.saving = true
    try {
      await this.deps.save(text)
      this.saved = text
      this.retries = 0
      this.set({ failure: null })
    } catch (error) {
      this.set({ failure: this.deps.errorText(error) })
      this.schedule(RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)] ?? SAVE_DELAY_MS)
      this.retries += 1
      return
    } finally {
      this.saving = false
    }
    this.settle()
  }

  /** Stops for good once the mod stops; a save already sent still finishes. */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
    this.listeners.clear()
  }

  /** The first load, which brings back text a failed save left in this browser. */
  private first(server: string): void {
    this.saved = server
    const backup = this.deps.backup.read()
    if (backup === null || backup === server) {
      this.deps.backup.write(null)
      this.set({ text: server, ready: true, failure: null })
      return
    }
    this.set({ text: backup, ready: true, failure: null })
    this.schedule(0)
  }

  /** After a save: clears the backup once all is saved, or saves what was typed meanwhile. */
  private settle(): void {
    if (this.pending()) {
      this.schedule(SAVE_DELAY_MS)
    } else {
      this.deps.backup.write(null)
    }
  }

  private pending(): boolean {
    return this.state.text !== this.saved
  }

  private schedule(delay: number, run: () => Promise<void> = async () => this.flush()): void {
    this.clearTimer()
    if (this.disposed) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void run()
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private set(next: Partial<PadState>): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) {
      listener()
    }
  }
}
