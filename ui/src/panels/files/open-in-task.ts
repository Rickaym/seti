import { navigate } from '@/lib/route'
import type { FileTarget } from '@/panels/files/files-api'

interface Pending {
  taskId: string
  target: FileTarget
}

let pending: Pending | null = null
const listeners = new Set<() => void>()

/** Hands a file to a task's Files pane, which opens it once that task shows. */
export function holdForTask(taskId: string, target: FileTarget): void {
  pending = { taskId, target }
  for (const listener of listeners) {
    listener()
  }
}

/** Opens a file in another task's Files view: shows that task, whose Files pane takes the file. */
export function openInTask(taskId: string, target: FileTarget): void {
  holdForTask(taskId, target)
  navigate('agents', taskId)
}

/** The file waiting for this task's Files pane, handed over once. */
export function takePending(taskId: string): FileTarget | null {
  if (pending?.taskId !== taskId) {
    return null
  }
  const { target } = pending
  pending = null
  return target
}

export function onPending(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
