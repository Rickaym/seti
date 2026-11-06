import { afterAll, beforeAll } from 'vitest'
import { modHost } from './mods/bundled.js'

/** Starts the bundled mods for one test file, as Seti does when it starts, and stops them after. */
export function withBundledMods(): void {
  beforeAll(async () => {
    await modHost.start()
  })
  afterAll(() => {
    modHost.stopAll()
  })
}
