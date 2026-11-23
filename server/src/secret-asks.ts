import type { NodeAnswer, NodeAsk } from '@seti/shared'
import { awsBroker } from './aws-credentials.js'
import { claudeCredential, connectorCredential } from './claude-credential.js'
import { tasks } from './db.js'
import { agentToken, tokenOwner } from './github-token.js'
import { profileAws } from './task-proxy.js'

async function taskOf(taskId: string) {
  const task = await tasks.get(taskId)
  if (task === undefined) {
    throw new Error(`No agent ${taskId}`)
  }
  return task
}

async function mint(taskId: string, ask: NodeAsk<'secret.mint'>): Promise<string | null> {
  if (ask.kind === 'claude') {
    return (await claudeCredential(ask.login))?.token ?? null
  }
  if (ask.kind === 'connector') {
    return connectorCredential()
  }
  const task = await taskOf(taskId)
  return agentToken(task.profile_id, ask.owner ?? tokenOwner(task))
}

/** What the control plane answers a node's egress proxy that needs a credential of the agent's. */
export const secretAnswers = {
  'secret.mint': async (taskId: string, ask: NodeAsk<'secret.mint'>): Promise<NodeAnswer<'secret.mint'>> => ({
    token: await mint(taskId, ask),
  }),
  'aws.credentials': async (taskId: string): Promise<NodeAnswer<'aws.credentials'>> => ({
    credentials: await awsBroker.credentials(await profileAws((await taskOf(taskId)).profile_id)),
  }),
}
