let nodePid: number | null = null

/** Takes the pid a separate node process reported, whose children are the agents' processes. */
export function setNodePid(pid: number | null): void {
  nodePid = pid
}

/** The processes agents' processes are children of: this one, and a separate node's. */
export const agentParents = (): readonly number[] => (nodePid === null ? [process.pid] : [process.pid, nodePid])
