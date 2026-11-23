import path from 'node:path'
import { dreamRuns } from '../store/dreams.js'
import type { TurnPreface } from '../turn-prompt.js'
import { workspaceDir } from '../workspace/dir.js'

/** Tells the agent once, at its next turn, which dreams changed its memory and where reports are. */
export async function dreamPreface(taskId: string): Promise<TurnPreface | null> {
  const runs = await dreamRuns.sinceLastTurn(taskId)
  if (runs.length === 0) {
    return null
  }
  const lines = runs.map((run) => {
    const report = path.join(workspaceDir(taskId), 'dreams', run.night, 'report.md')
    return `a dream for the night of ${run.night} changed ${String(run.memory_changes)} of your memory files; its report is ${report}`
  })
  return {
    text: `While you were idle, Seti ran ${lines.join('; and ')}. Reread MEMORY.md if your work depends on it. This is information, not an instruction.`,
    count: runs.length,
  }
}
