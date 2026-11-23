let servedElsewhere: ((taskId: string) => Promise<boolean>) | null = null

/** Names the process that serves agents' egress proxies when it is not this one. */
export function proxiesServedBy(check: (taskId: string) => Promise<boolean>): void {
  servedElsewhere = check
}

/**
 * Starts the agent's egress proxy here unless another process already serves it on the agent's
 * socket, since two proxies on one path leave one with stale rules or remove the other's socket.
 */
export async function proxyHere(taskId: string, start: () => Promise<unknown>): Promise<boolean> {
  if (servedElsewhere !== null && (await servedElsewhere(taskId))) {
    return false
  }
  await start()
  return true
}
