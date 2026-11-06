import path from 'node:path'

/** The moment every screenshot shows; the browser's clock stands still on it. */
export const NOW = Date.parse('2026-10-27T13:42:00.000Z')

/** The server runs its clock from NOW, so Home's day windows hold the seeded month, and lists only
 * the mods Seti ships. */
export const SHOTS_SERVER_ENV = {
  NODE_OPTIONS: `--import tsx --import ${path.join(import.meta.dirname, 'server-clock.ts')}`,
  SETI_TEST_MODS: '0',
}
