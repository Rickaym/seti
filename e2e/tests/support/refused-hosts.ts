import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { unique } from './fixtures.js'

/** An idle agent whose sandbox refused a fresh host 41 times; returns its id and the host. */
export async function seedRefusedHost(title: string): Promise<{ id: string; host: string }> {
  const id = unique('refused')
  const host = `${unique('crates')}.example.com`
  const at = new Date().toISOString()
  const db = openSeedDb()
  try {
    await db.idleTask(id, title, paths.checkout, at)
    const payload = { error: `Sandbox refused ${host}`, refused_host: host, refused_count: 41 }
    await db.message(id, 'seti', JSON.stringify(payload), at)
  } finally {
    await db.close()
  }
  return { id, host }
}
