import type { SetiControlLevel, Task } from '@seti/shared'

/** The Seti control level each agent's current Claude Code process started with. */
const processControl = new Map<string, SetiControlLevel>()

/** Records the Seti control level a process of the agent starts with. */
export function noteProcessControl(task: Pick<Task, 'id' | 'seti_control'>): void {
  processControl.set(task.id, task.seti_control)
}

/** The level whose tools the agent's current process has; undefined before one starts. */
export const processSetiControl = (taskId: string): SetiControlLevel | undefined => processControl.get(taskId)
