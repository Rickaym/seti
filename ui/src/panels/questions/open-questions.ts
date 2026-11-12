import { navigate } from '@/lib/route'

let pending: string | null = null
const listeners = new Set<() => void>()

/** Asks the agent's Questions drawer to open: now if the agent shows, else once it does. */
export function holdQuestions(taskId: string): void {
  pending = taskId
  for (const listener of listeners) {
    listener()
  }
}

/** Opens the agent's Questions drawer, showing the agent first unless a view of it took the ask. */
export function openQuestionsIn(taskId: string): void {
  holdQuestions(taskId)
  if (pending === taskId) {
    navigate('agents', taskId)
  }
}

/** Whether the agent's drawer was asked to open, handed over once. */
export function takeQuestions(taskId: string): boolean {
  if (pending !== taskId) {
    return false
  }
  pending = null
  return true
}

export function onQuestionsHeld(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
