import { useSyncExternalStore } from 'react'

/** How many MCP status reports each task's stream brought, so views showing that status reload. */
const counts = new Map<string, number>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function noteMcpReport(taskId: string): void {
  counts.set(taskId, (counts.get(taskId) ?? 0) + 1)
  for (const listener of listeners) {
    listener()
  }
}

/** Changes each time the task's session reports how its MCP servers connect. */
export function useMcpReports(taskId: string): number {
  return useSyncExternalStore(subscribe, () => counts.get(taskId) ?? 0)
}
