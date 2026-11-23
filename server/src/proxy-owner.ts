import type { Task } from '@seti/shared'

/** The process that runs agents' egress proxies, when it is not this one. */
interface ProxyOwner {
  open: (task: Task) => Promise<void>
  close: (taskId: string) => Promise<void>
  /** The token the agent's processes show the proxy to fetch AWS credentials. */
  awsToken: (taskId: string) => Promise<string>
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
export async function proxyHere(task: Task, start: () => Promise<void>): Promise<void> {
  await (owner === null ? start() : owner.open(task))
}

/** Stops a removed agent's egress proxy where it runs. */
export async function proxyGone(taskId: string, close: () => Promise<void>): Promise<void> {
  await (owner === null ? close() : owner.close(taskId))
}

/** The AWS token of the agent's egress proxy, from the process that runs it. */
export async function proxyAwsToken(taskId: string, here: () => string): Promise<string> {
  return owner === null ? here() : owner.awsToken(taskId)
}
