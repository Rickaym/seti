import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { Envelope, TeamMessage } from '@seti/shared'
import { openSeedDb } from './db.js'
import { EA_HEADERS, paths } from './env.js'

export interface DirectSeed {
  /** The direct message between two agents. */
  secret: string
  /** A public message posted beside it. */
  open: string
  /** The recipient agent's handle. */
  to: string
}

/** Two agents trade a direct message while a third posts in public; no agent runs. */
export async function seedDirect(): Promise<DirectSeed> {
  const db = openSeedDb()
  const stamp = Date.now().toString(36)
  const at = new Date().toISOString()
  const [from, to, third] = ['dmfrom', 'dmto', 'dmthird'].map((name) => ({ id: randomUUID(), handle: name + stamp }))
  if (from === undefined || to === undefined || third === undefined) {
    throw new Error('three agents were not made')
  }
  for (const agent of [from, to, third]) {
    await db.idleTask(agent.id, `Direct ${agent.handle}`, paths.checkout, at)
    await db.run(
      `INSERT INTO team_member (task_id, handle, muted, updated_at) VALUES (?, ?, 0, ?)`,
      agent.id,
      agent.handle,
      at,
    )
  }
  const seed = { secret: `Private key rotation note ${stamp}`, open: `Public build note ${stamp}`, to: to.handle }
  await db.run(
    `INSERT INTO team_message (author_kind, author_task_id, author_handle, text, mentions, created_at)
     VALUES ('task', ?, ?, ?, '[]', ?)`,
    third.id,
    third.handle,
    seed.open,
    at,
  )
  await db.run(
    `INSERT INTO team_message (author_kind, author_task_id, author_handle, text, mentions, to_kind, to_task_id,
       to_handle, created_at)
     VALUES ('task', ?, ?, ?, ?, 'task', ?, ?, ?)`,
    from.id,
    from.handle,
    seed.secret,
    JSON.stringify([{ handle: to.handle, task_id: to.id }]),
    to.id,
    to.handle,
    at,
  )
  await db.close()
  return seed
}

/** The texts the EA reads in the group chat, which leave out direct messages it is not part of. */
export async function eaReads(request: APIRequestContext): Promise<string[]> {
  const response = await request.get('/api/team/messages?limit=200', { headers: EA_HEADERS })
  return ((await response.json()) as Envelope<TeamMessage[]>).data.map((message) => message.text)
}
