import type { Question } from '@seti/shared'
import { useMemo } from 'react'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource, polledCount } from '@/lib/polled'

const open = createPolledResource<Question[]>('/questions', 5_000)

const NONE: readonly Question[] = []

/** Every agent's open questions, oldest first. */
export function useOpenQuestions(): readonly Question[] {
  return usePolled(open).data ?? NONE
}

/** The agent's open questions, and whether the first answer came, so none means none. */
export function useAgentQuestions(taskId: string): { questions: readonly Question[]; loaded: boolean } {
  const { data } = usePolled(open)
  const questions = useMemo(() => (data ?? NONE).filter((question) => question.task_id === taskId), [data, taskId])
  return { questions, loaded: data !== undefined }
}

/** How many questions the agent has open. */
export function useAgentQuestionCount(taskId: string): number {
  return useOpenQuestions().filter((question) => question.task_id === taskId).length
}

/** How many questions are open, as the Questions section's count. */
export const openQuestionCount = polledCount(open, (questions) => questions.length)

/** Reads the open questions again now, as after the user answered some. */
export function refreshQuestions(): void {
  open.refresh()
}
