import { z } from 'zod'
import type { ChangeRequest } from './change-requests.js'
import type { KnowledgeNote } from './knowledge.js'
import type { PermissionRequest } from './permissions.js'
import type { Question } from './questions.js'

/**
 * The formal requests that wait on the user's answer, in the order the Requests panel lists
 * them: questions, access changes, plan approvals, tool calls, then knowledge notes.
 */
export const REQUEST_KINDS = ['questions', 'access', 'plans', 'tools', 'notes'] as const
export type RequestKind = (typeof REQUEST_KINDS)[number]

/** A request that holds an agent, with the agent's title. */
export type TitledRequest<T> = T & { task_title: string }

/**
 * A held request with its digest: Seti's fingerprint of what it asks, which the EA binds the
 * user's yes to, so a request that changed after the EA read it back is refused.
 */
export type DigestedRequest<T> = TitledRequest<T> & { digest: string }

/** Every pending request by kind; the EA answers tool calls and plans only on the user's word. */
export interface PendingRequests {
  questions: Question[]
  access: TitledRequest<ChangeRequest>[]
  /** Tool calls and plans the agents wait on the user to allow, oldest first. */
  permissions: DigestedRequest<PermissionRequest>[]
  /** Knowledge notes waiting for approval, which never hold an agent up. */
  notes: KnowledgeNote[]
}

export const NO_REQUESTS: PendingRequests = { questions: [], access: [], permissions: [], notes: [] }

/** A plan approval: Claude Code's ExitPlanMode call, held like any other tool call. */
export const isPlanRequest = (request: Pick<PermissionRequest, 'tool_name'>) => request.tool_name === 'ExitPlanMode'

/** The agent a request belongs to; a note filed by the EA or the user belongs to none. */
export const noteTaskId = (note: Pick<KnowledgeNote, 'proposer_task_id'>) => note.proposer_task_id

/** How many requests wait, of every agent or of one. */
export function requestCount(pending: PendingRequests, taskId?: string): number {
  const mine = (id: string | null) => taskId === undefined || id === taskId
  return (
    pending.questions.filter((question) => mine(question.task_id)).length +
    pending.access.filter((request) => mine(request.task_id)).length +
    pending.permissions.filter((request) => mine(request.task_id)).length +
    pending.notes.filter((note) => mine(noteTaskId(note))).length
  )
}

/** The agents a question, an access change, a tool call or a plan holds up. */
export function heldAgents(pending: PendingRequests): Set<string> {
  return new Set([
    ...pending.questions.map((question) => question.task_id),
    ...pending.access.map((request) => request.task_id),
    ...pending.permissions.map((request) => request.task_id),
  ])
}

export const requestListQuery = z.object({
  task_id: z
    .string()
    .regex(/^[\w-]{1,100}$/)
    .optional(),
})
