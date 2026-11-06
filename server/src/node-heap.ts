import type { MemoryCap } from '@seti/shared'

/** Heap for Node tools agents run, such as tsc on a large repo, where no memory cap holds them. */
const UNCAPPED_HEAP_MB = 6144

/** The share of a memory cap a Node tool's heap may take, leaving room for Claude Code and more. */
const CAP_HEAP_SHARE = 0.7

/** The heap size, in MiB, Node tools of an agent default to under `cap`, or with no cap. */
export function agentHeapMb(cap: MemoryCap | null): number {
  return cap === null ? UNCAPPED_HEAP_MB : Math.floor(cap.max_mb * CAP_HEAP_SHARE)
}

export const agentHeapFlag = (cap: MemoryCap | null) => `--max-old-space-size=${String(agentHeapMb(cap))}`

const HEAP_SIZE = /(^|\s)--max[-_]old[-_]space[-_]size(=|\s|$)/

/** NODE_OPTIONS with the agent heap size appended, unless it already sets one. */
export function withAgentHeap(nodeOptions: string | undefined, cap: MemoryCap | null): string {
  const current = nodeOptions?.trim() ?? ''
  if (HEAP_SIZE.test(current)) {
    return current
  }
  const flag = agentHeapFlag(cap)
  return current === '' ? flag : `${current} ${flag}`
}

/** The cap in MiB for the agent's tools to read, when one holds its process tree. */
const MEMORY_CAP_ENV = 'SETI_MEMORY_CAP_MB'

/** NODE_OPTIONS and the cap for an agent's process tree, from the cap that holds it if any. */
export function memoryEnv(nodeOptions: string | undefined, cap: MemoryCap | null): Record<string, string> {
  return {
    NODE_OPTIONS: withAgentHeap(nodeOptions, cap),
    ...(cap === null ? {} : { [MEMORY_CAP_ENV]: String(cap.max_mb) }),
  }
}
