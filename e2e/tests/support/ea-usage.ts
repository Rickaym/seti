import { openSeedDb } from './db.js'

const DAY_MS = 24 * 60 * 60 * 1000

const CALLS: [channel: string, ttfbMs: number, daysAgo: number][] = [
  ['voice', 500, 0],
  ['voice', 700, 0],
  ['voice', 900, 0],
  ['chat', 1100, 0],
  ['inbox', 1300, 3],
]

/** Replaces the EA's usage with five model calls, four of them today, and one speech sample each. */
export async function seedEaUsage(): Promise<void> {
  const db = openSeedDb()
  try {
    await db.run('DELETE FROM ea_usage')
    for (const [channel, ttfb, daysAgo] of CALLS) {
      const at = new Date(Date.now() - daysAgo * DAY_MS).toISOString()
      await db.run(
        `INSERT INTO ea_usage (at, kind, channel, model, ttfb_ms, prompt_tokens, cached_tokens, completion_tokens,
          tool_calls) VALUES (?, 'llm', ?, 'gpt-4.1', ?, 16000, 8000, 60, 1)`,
        at,
        channel,
        ttfb,
      )
    }
    const now = new Date().toISOString()
    await db.run(
      `INSERT INTO ea_usage (at, kind, channel, model, ttfb_ms) VALUES (?, 'stt', 'voice', 'nova-3', 300)`,
      now,
    )
    await db.run(`INSERT INTO ea_usage (at, kind, channel, model, ttfb_ms) VALUES (?, 'tts', 'voice', NULL, 200)`, now)
  } finally {
    await db.close()
  }
}

/** Removes every EA usage row, as before the EA's first model call. */
export async function clearEaUsage(): Promise<void> {
  const db = openSeedDb()
  try {
    await db.run('DELETE FROM ea_usage')
  } finally {
    await db.close()
  }
}
