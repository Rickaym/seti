import { NO_REQUESTS, noteTaskId, requestCount, type PendingRequests } from '@seti/shared'
import { useMemo } from 'react'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource, polledCount } from '@/lib/polled'

const pending = createPolledResource<PendingRequests>('/requests', 5_000)

/** Every pending request, and whether the first answer came, so none means none. */
export function useRequests(): { requests: PendingRequests; loaded: boolean } {
  const { data } = usePolled(pending)
  return { requests: data ?? NO_REQUESTS, loaded: data !== undefined }
}

/** One agent's pending requests of every kind. */
export function useAgentRequests(taskId: string): { requests: PendingRequests; loaded: boolean } {
  const { requests, loaded } = useRequests()
  const mine = useMemo(
    () => ({
      questions: requests.questions.filter((question) => question.task_id === taskId),
      access: requests.access.filter((request) => request.task_id === taskId),
      permissions: requests.permissions.filter((request) => request.task_id === taskId),
      notes: requests.notes.filter((note) => noteTaskId(note) === taskId),
    }),
    [requests, taskId],
  )
  return { requests: mine, loaded }
}

/** How many requests of every kind the agent has pending. */
export function useAgentRequestCount(taskId: string): number {
  return requestCount(useRequests().requests, taskId)
}

/** How many questions the agent has open. */
export function useAgentQuestionCount(taskId: string): number {
  return useRequests().requests.questions.filter((question) => question.task_id === taskId).length
}

/** How many requests wait, as the Requests section's count. */
export const pendingRequestCount = polledCount(pending, (data) => requestCount(data))

/** Reads the pending requests again now, as after the user answered some. */
export function refreshRequests(): void {
  pending.refresh()
}
