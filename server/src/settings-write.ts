import { sql, type Db } from './db.js'

/** Where a settings save writes, and how its audit and side effects run once the write holds. */
export interface SettingsWrite {
  db: Db
  /** Runs an audit or side effect of the save: at once, or after a JSON write commits. */
  after: (effect: () => Promise<void>) => Promise<void>
}

/** A save on its own, as a settings page makes it: written and audited at once. */
export const DIRECT: SettingsWrite = { db: sql, after: async (effect) => effect() }

/** Saves inside one transaction whose audits and side effects wait until it commits. */
export function deferredWrite(tx: Db): { write: SettingsWrite; settle: () => Promise<void> } {
  const effects: (() => Promise<void>)[] = []
  const after = async (effect: () => Promise<void>) => {
    effects.push(effect)
    return Promise.resolve()
  }
  const settle = async () => {
    for (const effect of effects) {
      await effect()
    }
  }
  return { write: { db: tx, after }, settle }
}
