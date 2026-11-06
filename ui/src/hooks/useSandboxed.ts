import type { Task } from '@seti/shared'
import { useSystem } from '@/hooks/useSystem'

/** Whether the task's commands run sandboxed: it asked to, and the setting is on. */
export function useSandboxed(task: Pick<Task, 'sandbox'>): boolean {
  const settingOn = useSystem().data?.sandbox.enabled ?? true
  return task.sandbox && settingOn
}
