import fs from 'node:fs'
import { dropDatabases } from './db.js'
import { SUITE_ROOT } from './env.js'

/** Each worker seeds and cleans up its own server; this catches what a crashed worker left. */
export default function globalSetup(): () => Promise<void> {
  return async () => {
    await dropDatabases('all')
    fs.rmSync(SUITE_ROOT, { recursive: true, force: true })
  }
}
