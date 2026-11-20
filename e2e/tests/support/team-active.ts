import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { TeamMember } from '@seti/shared'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { apiData } from './fixtures.js'

interface Agent {
  id: string
  handle: string
}

export interface ActiveSeed {
  /** One agent created today and one that ended a turn today. */
  active: [Agent, Agent]
  /** An agent last busy days ago. */
  inactive: Agent
}

const DAYS_AGO = new Date(Date.now() - 3 * 86_400_000).toISOString()

/** Two agents that worked today and one that did not; no agent runs. */
export async function seedActive(): Promise<ActiveSeed> {
  const db = openSeedDb()
  const stamp = Date.now().toString(36)
  const now = new Date().toISOString()
  const make = async (name: string, createdAt: string): Promise<Agent> => {
    const agent = { id: randomUUID(), handle: name + stamp }
    await db.idleTask(agent.id, `Active check ${agent.handle}`, paths.checkout, createdAt)
    await db.run(
      `INSERT INTO team_member (task_id, handle, muted, updated_at) VALUES (?, ?, 0, ?)`,
      agent.id,
      agent.handle,
      createdAt,
    )
    return agent
  }
  const fresh = await make('fresh', now)
  const worked = await make('worked', DAYS_AGO)
  await db.run(`UPDATE task SET turn_ended_at = ? WHERE id = ?`, now, worked.id)
  const inactive = await make('quiet', DAYS_AGO)
  await db.close()
  return { active: [fresh, worked], inactive }
}

/** The composer's line for @active, from the roster the server reports now. */
export async function activeHint(request: APIRequestContext): Promise<string> {
  const count = (await apiData<TeamMember[]>(request, '/team/members')).filter((m) => m.active_today).length
  if (count === 0) {
    return 'No agents active today'
  }
  return `${String(count)} ${count === 1 ? 'agent' : 'agents'} active today`
}
