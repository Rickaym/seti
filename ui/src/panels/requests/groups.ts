import {
  isPlanRequest,
  REQUEST_KINDS,
  type ChangeRequest,
  type KnowledgeNote,
  type PendingRequests,
  type PermissionRequest,
  type Question,
  type RequestKind,
} from '@seti/shared'

/** Which kinds the panel shows: one, or all of them. */
export type KindFilter = RequestKind | 'all'

/** Whom a group's requests come from: an agent, or the EA or the user for a note. */
interface Owner {
  key: string
  /** The agent the requests belong to; null for notes the EA or the user filed. */
  taskId: string | null
  title: string
}

/** One agent's pending requests, or the notes the EA or the user filed. */
export interface RequestGroup extends Owner {
  questions: Question[]
  access: ChangeRequest[]
  plans: PermissionRequest[]
  tools: PermissionRequest[]
  notes: KnowledgeNote[]
  /** Whether a request in it holds the agent up, which puts it first. */
  holds: boolean
  /** When its oldest request came; the longest wait comes first. */
  since: string
}

/** How many requests of each kind wait. */
export function kindCounts(pending: PendingRequests): Record<RequestKind, number> {
  const plans = pending.permissions.filter(isPlanRequest).length
  return {
    questions: pending.questions.length,
    access: pending.access.length,
    plans,
    tools: pending.permissions.length - plans,
    notes: pending.notes.length,
  }
}

/** The kinds that have a request waiting, in the panel's order. */
export const kindsWaiting = (counts: Record<RequestKind, number>) => REQUEST_KINDS.filter((kind) => counts[kind] > 0)

function noteOwner(note: KnowledgeNote): Owner {
  if (note.proposer_task_id !== null) {
    return { key: note.proposer_task_id, taskId: note.proposer_task_id, title: note.proposer_title ?? 'An agent' }
  }
  return note.proposer === 'ea'
    ? { key: 'ea', taskId: null, title: 'The EA' }
    : { key: 'user', taskId: null, title: 'You' }
}

const agent = (request: { task_id: string; task_title: string }): Owner => ({
  key: request.task_id,
  taskId: request.task_id,
  title: request.task_title,
})

/**
 * The requests the filter shows, by agent: the agents a request holds up first, then the notes,
 * and the longest wait first within each.
 */
export function requestGroups(pending: PendingRequests, filter: KindFilter): RequestGroup[] {
  const shows = (kind: RequestKind) => filter === 'all' || filter === kind
  const groups = new Map<string, RequestGroup>()
  const add = (owner: Owner, at: string, holds: boolean): RequestGroup => {
    const group = groups.get(owner.key) ?? {
      ...owner,
      ...{ questions: [], access: [], plans: [], tools: [], notes: [] },
      holds,
      since: at,
    }
    group.holds ||= holds
    group.since = at < group.since ? at : group.since
    groups.set(owner.key, group)
    return group
  }
  for (const question of shows('questions') ? pending.questions : []) {
    add(agent(question), question.created_at, true).questions.push(question)
  }
  for (const request of shows('access') ? pending.access : []) {
    add(agent(request), request.created_at, true).access.push(request)
  }
  for (const request of pending.permissions) {
    const kind = isPlanRequest(request) ? 'plans' : 'tools'
    if (shows(kind)) {
      add(agent(request), request.created_at, true)[kind].push(request)
    }
  }
  for (const note of shows('notes') ? pending.notes : []) {
    add(noteOwner(note), note.created_at, false).notes.push(note)
  }
  return [...groups.values()].sort((a, b) =>
    a.holds === b.holds ? a.since.localeCompare(b.since) : Number(b.holds) - Number(a.holds),
  )
}

/** How many requests the group holds. */
export const groupSize = (group: RequestGroup) =>
  group.questions.length + group.access.length + group.plans.length + group.tools.length + group.notes.length
