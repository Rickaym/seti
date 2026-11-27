import type { Task } from '@seti/shared'
import { sandboxed } from './aws-access.js'
import { grantedConnections } from './proxy-grant.js'
import { proxyConnections } from './proxy-owner.js'
import { regrantConnections } from './task-proxy.js'

/**
 * Hands the sandboxed agent's running proxy and shells its credential's connections now,
 * read as its next start reads them, so a connection the user just placed works in the
 * same turn. False when it runs unsandboxed, no proxy runs for it or the hand-over failed;
 * then its next turn takes it.
 */
export async function connectionsNow(task: Task): Promise<boolean> {
  if (!(await sandboxed(task))) {
    return false
  }
  try {
    const connections = await grantedConnections(task)
    return await proxyConnections(task.id, connections, async () => regrantConnections(task.id, connections))
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    process.stderr.write(`connections: the running sandbox of ${task.id} keeps its connections: ${why}\n`)
    return false
  }
}
