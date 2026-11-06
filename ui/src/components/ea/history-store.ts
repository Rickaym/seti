import type { EaHistoryEntry, EaHistoryPage } from '@seti/shared'

export interface HistoryState {
  entries: EaHistoryEntry[]
  hasOlder: boolean
  loading: boolean
  error: string | null
  /** Counts new conversations, so pages loaded before one never mix with it. */
  epoch: number
}

export interface HistoryDeps {
  load: () => Promise<EaHistoryPage>
  clear: () => Promise<void>
  later: (task: () => void, ms: number) => void
}

/** Time for the bot to store the last turns after a hang-up. */
export const SETTLE_MS = 1500

const initialHistory: HistoryState = {
  entries: [],
  hasOlder: false,
  loading: false,
  error: null,
  epoch: 0,
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The EA's stored conversation as the EA chat shows it. */
export class EaHistoryStore {
  private state: HistoryState = initialHistory
  private readonly listeners = new Set<() => void>()
  private readonly deps: HistoryDeps
  private epoch = 0

  constructor(deps: HistoryDeps) {
    this.deps = deps
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): HistoryState => this.state

  private set(patch: Partial<HistoryState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) {
      listener()
    }
  }

  private async load(): Promise<void> {
    const epoch = this.epoch
    this.set({ loading: true })
    try {
      const page = await this.deps.load()
      if (epoch === this.epoch) {
        this.set({ entries: page.entries, hasOlder: page.has_older, loading: false, error: null })
      }
    } catch (e) {
      if (epoch === this.epoch) {
        this.set({ loading: false, error: errorText(e) })
      }
    }
  }

  readonly refresh = async (): Promise<void> => this.load()

  /** Loads again once the bot has had time to store the last turns of a call. */
  readonly callEnded = (): void => {
    this.deps.later(() => {
      void this.load()
    }, SETTLE_MS)
  }

  /** Forgets the conversation in Seti; throws when Seti refuses. */
  readonly clear = async (): Promise<void> => {
    await this.deps.clear()
    this.epoch += 1
    this.set({
      entries: [],
      hasOlder: false,
      loading: false,
      error: null,
      epoch: this.epoch,
    })
  }
}
