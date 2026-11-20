import { AWS_SETTINGS_DEFAULT, type Task } from '@seti/shared'
import { taskSsh } from './agent-access.js'
import { taskAws } from './aws-access.js'
import { awsBroker, type ContainerCredentials } from './aws-credentials.js'
import { claudeCredential, connectorCredential } from './claude-credential.js'
import { hostLoginKey } from './claude-logins.js'
import { auditBlockedKey, storedConnections, taskConnections } from './connection-egress.js'
import { connectionValue } from './connection-values.js'
import { agentToken, agentTokenStamp } from './github-token.js'
import { taskBorrowedServers } from './mcp-borrowed.js'
import { connectorIds, taskDeniedServers } from './mcp-selection.js'
import { hostKeys, sshFiles, type SshFiles } from './ssh-files.js'
import { allowedFor } from './store/change-requests.js'
import type { ConnectionRow } from './store/connections.js'
import { profiles } from './store/credentials.js'

/** What a task's sandbox starts with from Seti's records: names and settings, never a value. */
export interface SandboxSetup {
  /** The MCP servers the task turned off, and the claude.ai connector ids among them. */
  deniedServers: string[]
  deniedConnectors: string[]
  /** The connections the task's credential carries, with the names of their secrets only. */
  connections: ConnectionRow[]
  /** The servers of other folders the task turned on, as their config. */
  borrowedServers: Record<string, unknown>
  /** The Claude login the session starts on, whose token its proxy keeps using. */
  login: string | null
  /** Whether the credential has a GitHub token, and the host login can reach connectors. */
  github: boolean
  connectors: boolean
  /** The region of the credential's AWS role, when the task has AWS on. */
  aws: { region: string } | null
  /** The task's usable ssh hosts as files, without private keys; null without any. */
  ssh: SshFiles | null
}

/** What the sandbox and its proxy saw, for Seti to record. */
export type SandboxFact =
  | { kind: 'host_refused'; taskId: string; host: string }
  | { kind: 'key_blocked'; task: Pick<Task, 'id' | 'title'>; host: string; names: string[] }

/**
 * Everything a task's sandbox and its egress proxy read from Seti's records and secrets, as plain
 * data. The proxy asks on every connection, so an edit applies at once.
 */
export interface SandboxAccess {
  setup: (task: Task) => Promise<SandboxSetup>
  /** The allowlist entries the task's proxy lets through: the shared list, then its own. */
  allowedHosts: (taskId: string) => Promise<string[]>
  /** The ssh hosts the task's proxy may connect to: the first hop of each usable host. */
  sshFirstHops: (taskId: string) => Promise<string[]>
  /** The private keys of the task's ssh hosts, read whenever its ssh agent reloads. */
  sshKeys: (taskId: string) => Promise<string[]>
  awsEnabled: (taskId: string) => Promise<boolean>
  awsCredentials: (profileId: string) => Promise<ContainerCredentials | null>
  /** The Claude token for the login a session started on. */
  claudeToken: (login: string | null) => Promise<string | null>
  githubToken: (profileId: string, owner: string | null) => Promise<string | null>
  connectorToken: () => Promise<string | null>
  connectionValue: (connection: ConnectionRow) => Promise<string | null>
  /** A fresh token for a minted connection after `refused` was refused; null for a key. */
  renewConnection: (connection: ConnectionRow, refused: string) => Promise<string | null>
  report: (fact: SandboxFact) => Promise<void>
}

const profileAws = async (profileId: string) => (await profiles.get(profileId))?.aws ?? AWS_SETTINGS_DEFAULT

async function setupOf(task: Task): Promise<SandboxSetup> {
  const denied = await taskDeniedServers(task.id)
  const aws = await taskAws(task.id)
  return {
    deniedServers: denied,
    deniedConnectors: connectorIds(denied),
    connections: await taskConnections(task),
    borrowedServers: await taskBorrowedServers(task),
    login: hostLoginKey(),
    github: (await agentTokenStamp(task.profile_id)) !== null,
    connectors: connectorCredential() !== null,
    aws: aws ? { region: (await profileAws(task.profile_id)).region } : null,
    ssh: await sshFiles(await taskSsh(task.id)),
  }
}

async function report(fact: SandboxFact): Promise<void> {
  if (fact.kind === 'key_blocked') {
    await auditBlockedKey(fact.task, fact.host, fact.names)
    return
  }
  process.stderr.write(`sandbox: task ${fact.taskId} was refused ${fact.host}\n`)
}

/** The access of a sandbox run by Seti's own process, straight from its records and secrets. */
export const inProcessSandboxAccess: SandboxAccess = {
  setup: setupOf,
  allowedHosts: allowedFor,
  sshFirstHops: async (taskId) => (await taskSsh(taskId)).firstHops,
  sshKeys: async (taskId) => hostKeys((await taskSsh(taskId)).hosts),
  awsEnabled: taskAws,
  awsCredentials: async (profileId) => awsBroker.credentials(await profileAws(profileId)),
  claudeToken: async (login) => (await claudeCredential(login))?.token ?? null,
  githubToken: agentToken,
  connectorToken: async () => Promise.resolve(connectorCredential()),
  connectionValue,
  renewConnection: storedConnections().renew,
  report,
}
