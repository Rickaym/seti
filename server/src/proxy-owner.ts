import type { ProxyGrant } from '@seti/shared'
import { reloadSshAgents } from './ssh-agent.js'

/** The process that runs agents' egress proxies, when it is not this one. */
interface ProxyOwner {
  open: (taskId: string, grant: ProxyGrant) => Promise<void>
  close: (taskId: string) => Promise<void>
  /** The token the agent's processes show the proxy to fetch AWS credentials. */
  awsToken: (taskId: string) => Promise<string>
  /** Starts the agent's ssh agent beside its proxy, so it outlives this process. */
  sshOpen: (taskId: string) => Promise<void>
  /** Reloads the keys of the ssh agents it runs. */
  sshReload: () => Promise<void>
}

let owner: ProxyOwner | null = null

/** Names the process that runs agents' egress proxies when it is not this one. */
export function proxiesRunBy(other: ProxyOwner): void {
  owner = other
}

/**
 * Starts the agent's egress proxy here, or has the process that runs agents' proxies open it,
 * since two proxies on one path leave one with stale rules or remove the other's socket.
 */
export async function proxyHere(taskId: string, grant: ProxyGrant, start: () => Promise<void>): Promise<void> {
  await (owner === null ? start() : owner.open(taskId, grant))
}

/** Stops a removed agent's egress proxy where it runs. */
export async function proxyGone(taskId: string, close: () => Promise<void>): Promise<void> {
  await (owner === null ? close() : owner.close(taskId))
}

/** The AWS token of the agent's egress proxy, from the process that runs it. */
export async function proxyAwsToken(taskId: string, here: () => string): Promise<string> {
  return owner === null ? here() : owner.awsToken(taskId)
}

/** Starts the agent's ssh agent here, or where proxies run, so one process owns its socket. */
export async function sshAgentHere(taskId: string, start: () => Promise<void>): Promise<void> {
  await (owner === null ? start() : owner.sshOpen(taskId))
}

/** Reloads the ssh agents' keys where they run, so a removed key leaves them at once. */
export async function sshKeysChanged(): Promise<void> {
  await (owner === null ? reloadSshAgents() : owner.sshReload())
}

/** The sandbox CA: loaded here when proxies run here, else only located, so one process writes it. */
export async function proxyCa<T>(load: () => Promise<T>, locate: () => T): Promise<T> {
  return owner === null ? load() : locate()
}
