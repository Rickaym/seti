import { createHash } from 'node:crypto'
import type { Task } from '@seti/shared'
import { agentTokenStamp } from './github-token.js'
import { profiles } from './store/credentials.js'

/** Changes whenever the task's profile does, so its session restarts with the new one. */
export async function profileStamp(task: Task): Promise<string | null> {
  const profile = await profiles.get(task.profile_id)
  if (profile === undefined) {
    return null
  }
  const github = await agentTokenStamp(profile.id)
  return createHash('sha256')
    .update(JSON.stringify([profile.id, profile.updated_at, github]))
    .digest('hex')
    .slice(0, 16)
}
