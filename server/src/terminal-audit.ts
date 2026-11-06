import type { AuditDetail, Task } from '@seti/shared'

export type AgentRef = Pick<Task, 'id' | 'title'>

/** A terminal opening or closing, under its agent, or under the system for the home folder. */
export function terminalAudit(task: AgentRef | null, closed: boolean, summary: string, detail: AuditDetail) {
  if (task === null) {
    return {
      kind: closed ? 'system.terminal_closed' : 'system.terminal_opened',
      subject_type: 'system',
      subject_id: null,
      summary: `${summary} in the home folder`,
      detail,
    } as const
  }
  return {
    kind: closed ? 'task.terminal_closed' : 'task.terminal_opened',
    subject_type: 'task',
    subject_id: task.id,
    summary: `${summary} in task "${task.title}"`,
    detail: { title: task.title, ...detail },
  } as const
}
