import type { NodeAnswer, NodeAsk } from '@seti/shared'
import { taskSsh } from './agent-access.js'
import { awsBroker } from './aws-credentials.js'
import { claudeCredential, connectorCredential } from './claude-credential.js'
import { taskConnections } from './connection-egress.js'
import { connectionToken } from './connection-values.js'
import { tasks } from './db.js'
import { agentToken, tokenOwner } from './github-token.js'
import { taskDeniedServers } from './mcp-selection.js'
import { mcpTokens } from './sandbox-mcp.js'
import { hostKeys } from './ssh-files.js'
import { profileAws } from './task-proxy.js'

async function taskOf(taskId: string) {
  const task = await tasks.get(taskId)
  if (task === undefined) {
    throw new Error(`No agent ${taskId}`)
  }
  return task
}

async function mcpToken(taskId: string, url: string): Promise<string | null> {
  const denied = new Set(await taskDeniedServers(taskId))
  return mcpTokens.tokenFor(new URL(url), (login) => !denied.has(login.name))
}

async function mint(taskId: string, ask: NodeAsk<'secret.mint'>): Promise<string | null> {
  switch (ask.kind) {
    case 'claude':
      return (await claudeCredential(ask.login))?.token ?? null
    case 'connector':
      return connectorCredential()
    case 'mcp':
      return mcpToken(taskId, ask.url)
    case 'github': {
      const task = await taskOf(taskId)
      return agentToken(task.profile_id, ask.owner ?? tokenOwner(task))
    }
  }
}

/** The connection's value while the agent's credential still carries it; read again each time. */
async function connectionValueOf(taskId: string, ask: NodeAsk<'connection.value'>): Promise<string | null> {
  const row = (await taskConnections(await taskOf(taskId))).find((each) => each.id === ask.connection)
  return row === undefined ? null : connectionToken(row, ask.refused)
}

/** What the control plane answers a node's egress proxy or ssh agent that needs a value. */
export const secretAnswers = {
  'secret.mint': async (taskId: string, ask: NodeAsk<'secret.mint'>): Promise<NodeAnswer<'secret.mint'>> => ({
    token: await mint(taskId, ask),
  }),
  'aws.credentials': async (taskId: string): Promise<NodeAnswer<'aws.credentials'>> => ({
    credentials: await awsBroker.credentials(await profileAws((await taskOf(taskId)).profile_id)),
  }),
  'connection.value': async (
    taskId: string,
    ask: NodeAsk<'connection.value'>,
  ): Promise<NodeAnswer<'connection.value'>> => ({ value: await connectionValueOf(taskId, ask) }),
  'ssh.keys': async (taskId: string): Promise<NodeAnswer<'ssh.keys'>> => ({
    keys: await hostKeys((await taskSsh(taskId)).hosts),
  }),
}
