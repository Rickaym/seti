/** Undoes one registration; calling it again does nothing. */
export type Disposer = () => void

/**
 * A contribution point: entries by key, in registration order, each added with a disposer that
 * removes exactly it. A key is taken once, so nothing can shadow core or another mod.
 */
export class Registry<T> {
  private entries = new Map<string, T>()
  private snapshot: readonly T[] = []
  private readonly listeners = new Set<() => void>()

  readonly point: string
  private readonly keyOf: (entry: T) => string

  constructor(point: string, keyOf: (entry: T) => string) {
    this.point = point
    this.keyOf = keyOf
  }

  /** Adds the entry and returns what removes it again; a taken key throws. */
  register = (entry: T): Disposer => {
    const key = this.keyOf(entry)
    if (this.entries.has(key)) {
      throw new Error(`The ${this.point} ${key} is already registered`)
    }
    this.update(new Map(this.entries).set(key, entry))
    return () => {
      if (this.entries.get(key) === entry) {
        const rest = new Map(this.entries)
        rest.delete(key)
        this.update(rest)
      }
    }
  }

  get = (key: string): T | undefined => this.entries.get(key)

  has = (key: string): boolean => this.entries.has(key)

  /** Every entry in registration order; the same array until the registry changes. */
  list = (): readonly T[] => this.snapshot

  subscribe = (listener: () => void): Disposer => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(next: Map<string, T>): void {
    this.entries = next
    this.snapshot = [...next.values()]
    for (const listener of this.listeners) {
      listener()
    }
  }
}

/** Runs every disposer once, newest first, and keeps going past one that throws. */
export function disposeAll(disposers: Disposer[]): Error[] {
  const errors: Error[] = []
  for (const dispose of disposers.splice(0).reverse()) {
    try {
      dispose()
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)))
    }
  }
  return errors
}
