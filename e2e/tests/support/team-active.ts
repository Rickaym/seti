import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { TeamMember } from '@seti/shared'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { apiData } from './fixtures.js'

export interface ActiveSeed {
  /** Handles of the two agents that ran a turn today. */
  today: string[]
  /** The handle of an agent whose last turn started two days ago. */
  stale: string
}

const DAY_MS = 86_400_000

/** Three idle agents, all recently updated so @all would reach them; only two ran a turn today. */
export async function seedActive(): Promise<ActiveSeed> {
  const db = openSeedDb()
  const stamp = Date.now().toString(36)
  const now = new Date().toISOString()
  const agents = [
    { handle: `acta${stamp}`, turn: now },
    { handle: `actb${stamp}`, turn: now },
    { handle: `actc${stamp}`, turn: new Date(Date.now() - 2 * DAY_MS).toISOString() },
  ]
  for (const agent of agents) {
    const id = randomUUID()
    await db.idleTask(id, `Active ${agent.handle}`, paths.checkout, now)
    await db.run(
      `INSERT INTO team_member (task_id, handle, muted, updated_at) VALUES (?, ?, 0, ?)`,
      id,
      agent.handle,
      now,
    )
    await db.message(id, 'prompt', JSON.stringify({ text: `Seeded turn of ${agent.handle}` }), agent.turn)
  }
  await db.close()
  const [first, second, third] = agents.map((agent) => agent.handle)
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error('three agents were not made')
  }
  return { today: [first, second], stale: third }
}

/** The hint @active shows now: how many unmuted agents ran a turn today, by the server's count. */
export async function activeHint(request: APIRequestContext): Promise<string> {
  const members = await apiData<TeamMember[]>(request, '/team/members')
  const count = members.filter((member) => member.worked_today && !member.muted).length
  return `${String(count)} ${count === 1 ? 'agent' : 'agents'} that ran a turn today`
}
