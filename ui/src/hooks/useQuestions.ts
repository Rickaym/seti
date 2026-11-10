import type { Question } from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const open = createPolledResource<Question[]>('/questions', 5_000)

const NONE: readonly Question[] = []

/** Every agent's open questions, oldest first. */
export function useOpenQuestions(): readonly Question[] {
  return usePolled(open).data ?? NONE
}

/** How many questions the agent has open. */
export function useAgentQuestionCount(taskId: string): number {
  return useOpenQuestions().filter((question) => question.task_id === taskId).length
}

/** Reads the open questions again now, as after the user answered some. */
export function refreshQuestions(): void {
  open.refresh()
}
