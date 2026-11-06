import type { Disposer } from '@seti/shared'

interface Switched {
  setting: string
  register: () => Disposer
  live: Disposer | null
}

/**
 * A running mod's registrations that one of its boolean settings turns on and off: each is
 * registered while its setting is on and undone while it is off, with no restart of the mod.
 */
export class ModSwitches {
  private readonly entries = new Set<Switched>()
  private off: ReadonlySet<string>

  constructor(off: readonly string[]) {
    this.off = new Set(off)
  }

  /** Registers now unless the setting is off; the disposer undoes it for good. */
  add(setting: string, register: () => Disposer): Disposer {
    const entry: Switched = { setting, register, live: this.off.has(setting) ? null : register() }
    this.entries.add(entry)
    return () => {
      entry.live?.()
      entry.live = null
      this.entries.delete(entry)
    }
  }

  /** Follows the settings that are off now, registering and undoing only what changed. */
  apply(off: readonly string[]): void {
    this.off = new Set(off)
    for (const entry of this.entries) {
      const on = !this.off.has(entry.setting)
      if (on && entry.live === null) {
        entry.live = entry.register()
      } else if (!on && entry.live !== null) {
        entry.live()
        entry.live = null
      }
    }
  }
}
