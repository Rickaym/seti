import type { CommandCatalog, ComposerCommand } from '@seti/shared'
import { errorText } from '@/api'

export interface CommandState {
  /** Null until loaded, or when the list could not be loaded. */
  commands: readonly ComposerCommand[] | null
  loading: boolean
  /** The list shown is a stand-in or out of date, and the exact one is being fetched. */
  updating: boolean
  error: string | null
}

interface Entry extends CommandState {
  at: number
}

const FRESH_MS = 5 * 60 * 1000
const RETRY_MS = 2000
/** A probe takes seconds; past about a minute of asking, it failed and the stand-in stays. */
const MAX_RETRIES = 30

export const IDLE_COMMANDS: CommandState = { commands: null, loading: false, updating: false, error: null }

/** Command lists by API path, shared by every composer, asked for again while not fresh. */
export class CommandCatalogStore {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private readonly load: (path: string) => Promise<CommandCatalog>
  private readonly retryMs: number

  constructor(load: (path: string) => Promise<CommandCatalog>, retryMs = RETRY_MS) {
    this.load = load
    this.retryMs = retryMs
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get(path: string): CommandState | undefined {
    return this.entries.get(path)
  }

  /** Starts loading a list unless a fresh copy, a request or a pending update already exists. */
  request(path: string): void {
    const entry = this.entries.get(path)
    if (entry && (entry.loading || entry.updating || (entry.error === null && Date.now() - entry.at < FRESH_MS))) {
      return
    }
    this.fetch(path, 0)
  }

  private fetch(path: string, attempt: number): void {
    const known = this.entries.get(path)?.commands ?? null
    this.update(path, { commands: known, loading: attempt === 0, updating: attempt > 0, error: null })
    this.load(path)
      .then((catalog) => {
        const updating = !catalog.fresh && attempt < MAX_RETRIES
        this.update(path, { commands: catalog.commands, loading: false, updating, error: null })
        if (updating) {
          setTimeout(() => {
            this.fetch(path, attempt + 1)
          }, this.retryMs)
        }
      })
      .catch((e: unknown) => {
        this.update(path, { commands: known, loading: false, updating: false, error: known ? null : errorText(e) })
      })
  }

  private update(path: string, state: CommandState): void {
    this.entries.set(path, { ...state, at: Date.now() })
    for (const listener of this.listeners) {
      listener()
    }
  }
}
