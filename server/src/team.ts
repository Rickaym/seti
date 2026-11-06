import {
  handleCandidates,
  isDirect,
  isReservedHandle,
  parseMentions,
  type AuditActor,
  type Task,
  type TeamDelivery,
  type TeamDeliveryMode,
  type TeamInput,
  type TeamMember,
  type TeamMention,
  type TeamMessage,
  type TeamPosted,
} from '@seti/shared'
import { audit } from './audit.js'
import { now, tasks } from './db.js'
import { refuseOtherAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { appendMessage, isRunning, runAutoTurn, sessionState } from './runner.js'
import { eaInbox } from './store/inbox.js'
import { teamDeliveries, teamMembers, teamMessages, type MemberRow } from './store/team.js'
import { inLane } from './task-lane.js'
import { auditDirect, auditPost } from './team-audit.js'
import { authorLabel, paced, speakerOf } from './team-author.js'
import { publishTeam } from './team-events.js'
import { stripSelfHeader } from './team-header.js'
import {
  recipientFields,
  recipientMention,
  recipientOf,
  type Recipient,
  type TaskRecipient,
  type TeamAuthor,
} from './team-recipient.js'

/** Busy within this window, a task still counts as active and hears @all and the EA. */
const ACTIVE_WINDOW_MS = 12 * 60 * 60_000
/** Messages from agents that may reach one task on their own within the window; more wait. */
export const TEAM_BURST = { deliveries: 12, windowMs: 15 * 60_000 } as const
/** Mentions two agents may trade within the window before further ones wait, ending a loop. */
export const TEAM_LOOP = { exchanges: 6, windowMs: 15 * 60_000 } as const

const NUMBERED_MAX = 99
const TITLE_CHARS = 140
const INBOX_CHARS = 1200

export type { TeamAuthor } from './team-recipient.js'
export { authorLabel } from './team-author.js'

/** A message's author fields and text, before it names who it goes to. */
type AuthoredText = Awaited<ReturnType<typeof authorFields>> & { text: string }

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`)

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The handles a title suggests, best first, then numbered ones for when those are taken. */
export function handleChoices(title: string): string[] {
  const candidates = handleCandidates(title)
  const base = candidates[0] ?? 'task'
  return [...candidates, ...Array.from({ length: NUMBERED_MAX - 1 }, (_, i) => `${base}-${String(i + 2)}`)]
}

/** The task's handle, taking the first free one its title suggests on first use. */
export async function ensureMember(task: Pick<Task, 'id' | 'title'>): Promise<MemberRow> {
  const existing = await teamMembers.get(task.id)
  if (existing !== undefined) {
    return existing
  }
  for (const handle of handleChoices(task.title)) {
    if (await teamMembers.claim(task.id, handle)) {
      break
    }
    const raced = await teamMembers.get(task.id)
    if (raced !== undefined) {
      return raced
    }
  }
  const member = await teamMembers.get(task.id)
  if (member === undefined) {
    throw new HttpError(409, `No free handle for agent "${task.title}"`)
  }
  return member
}

const isActive = (task: Task, at: number) =>
  task.status === 'running' || sessionState(task.id).open || at - Date.parse(task.updated_at) < ACTIVE_WINDOW_MS

const toMember = (task: Task, member: MemberRow, at: number): TeamMember => ({
  task_id: task.id,
  handle: member.handle,
  title: task.title,
  status: task.status,
  muted: member.muted,
  active: isActive(task, at),
})

/** Every task with its handle, active ones first. */
export async function teamRoster(at = Date.now()): Promise<TeamMember[]> {
  const list = await tasks.list()
  const members = new Map((await teamMembers.list()).map((member) => [member.task_id, member]))
  const roster: TeamMember[] = []
  for (const task of list) {
    roster.push(toMember(task, members.get(task.id) ?? (await ensureMember(task)), at))
  }
  return roster.sort((a, b) => Number(b.active) - Number(a.active))
}

export async function teamMemberOf(taskId: string): Promise<TeamMember> {
  const task = await tasks.get(taskId)
  if (!task) {
    throw new HttpError(404, 'Task not found')
  }
  return toMember(task, await ensureMember(task), Date.now())
}

/** Renames a task's handle or mutes it, for the user or for the task's own agent. */
export async function updateMember(
  taskId: string,
  change: { handle?: string | undefined; muted?: boolean | undefined },
  actor: Extract<AuditActor, 'user' | 'agent'>,
): Promise<TeamMember> {
  refuseOtherAgent(taskId)
  const before = await teamMemberOf(taskId)
  if (change.handle !== undefined && change.handle !== before.handle) {
    if (!(await teamMembers.setHandle(taskId, change.handle))) {
      throw new HttpError(409, `@${change.handle} is taken by another agent`)
    }
  }
  if (change.muted !== undefined && change.muted !== before.muted) {
    await teamMembers.setMuted(taskId, change.muted)
  }
  const after = await teamMemberOf(taskId)
  if (after.handle === before.handle && after.muted === before.muted) {
    return after
  }
  const what = [
    ...(after.handle === before.handle ? [] : [`renamed @${before.handle} to @${after.handle}`]),
    ...(after.muted === before.muted ? [] : [after.muted ? 'muted the team chat' : 'unmuted the team chat']),
  ]
  await audit.record({
    actor,
    kind: 'team.member_changed',
    subject_type: 'task',
    subject_id: taskId,
    summary: `For task "${after.title}": ${what.join(', ')}`,
    detail: { title: after.title, handle: after.handle, previous_handle: before.handle, muted: after.muted },
  })
  publishTeam({ type: 'member', member: after })
  return after
}

export async function authorFields(author: TeamAuthor) {
  if (author.kind === 'mod') {
    return { author_kind: author.kind, author_task_id: null, author_handle: null, author_mod_id: author.modId }
  }
  if (author.kind !== 'task') {
    return { author_kind: author.kind, author_task_id: null, author_handle: null, author_mod_id: null }
  }
  const task = await tasks.get(author.taskId)
  if (!task) {
    throw new HttpError(404, 'Task not found')
  }
  const handle = (await ensureMember(task)).handle
  return { author_kind: author.kind, author_task_id: task.id, author_handle: handle, author_mod_id: null }
}

export async function resolveMentions(
  handles: readonly string[],
): Promise<{ mentions: TeamMention[]; unknown: string[] }> {
  const found = new Map((await teamMembers.byHandles(handles)).map((member) => [member.handle, member.task_id]))
  const mentions: TeamMention[] = []
  const unknown: string[] = []
  for (const handle of handles) {
    const taskId = found.get(handle)
    if (isReservedHandle(handle) || taskId !== undefined) {
      mentions.push({ handle, task_id: taskId ?? null })
    } else {
      unknown.push(handle)
    }
  }
  return { mentions, unknown }
}

export interface Plan {
  task: Task
  member: MemberRow
  kind: TeamInput['kind']
  /** A person's mention joins a running turn at once; anything else at the turn's next step. */
  priority: 'now' | 'next'
  /** Why the message is not handed over, or waits for the task's next turn; null to hand it over. */
  skip: string | null
  hold: string | null
  startIdle: boolean
}

/** Mentioned tasks, plus every active one for @all and for the EA; never the author itself. */
async function plan(author: TeamAuthor, message: TeamMessage, at: number): Promise<Plan[]> {
  const handles = new Set(message.mentions.map((mention) => mention.handle))
  const mentioned = new Set(message.mentions.flatMap((mention) => (mention.task_id === null ? [] : [mention.task_id])))
  const toAll = handles.has('all') || author.kind === 'ea'
  const members = new Map((await teamMembers.list()).map((member) => [member.task_id, member]))
  const plans: Plan[] = []
  for (const task of await tasks.list()) {
    const isMention = mentioned.has(task.id)
    if ((author.kind === 'task' && author.taskId === task.id) || !(isMention || (toAll && isActive(task, at)))) {
      continue
    }
    const member = members.get(task.id) ?? (await ensureMember(task))
    plans.push(await planFor(author, handles, { task, member, isMention }, at))
  }
  return plans
}

async function planFor(
  author: TeamAuthor,
  handles: Set<string>,
  { task, member, isMention }: { task: Task; member: MemberRow; isMention: boolean },
  at: number,
): Promise<Plan> {
  const escalated = handles.has('user')
  return {
    task,
    member,
    kind: isMention ? 'mention' : 'broadcast',
    priority: isMention && !paced(author) ? 'now' : 'next',
    skip: member.muted ? 'muted' : null,
    hold: (await holdReason(author, task, at)) ?? (isMention && !escalated ? await loopReason(author, task, at) : null),
    startIdle: isMention || (handles.has('all') && !paced(author)),
  }
}

/**
 * A direct message reaches its agent like a mention; while muted, it waits for the next turn.
 * A reply, like an agent's message, reaches a running turn at its next step.
 */
async function directPlan(author: TeamAuthor, to: TaskRecipient, reply: boolean): Promise<Plan> {
  const { task, member } = to
  const at = Date.now()
  const held = (await holdReason(author, task, at)) ?? (await loopReason(author, task, at))
  return {
    task,
    member,
    kind: 'direct',
    priority: paced(author) || reply ? 'next' : 'now',
    skip: null,
    hold: held ?? (member.muted ? 'muted' : null),
    startIdle: true,
  }
}

/** Two agents that keep mentioning each other wait for their next turns until the window passes. */
async function loopReason(author: TeamAuthor, task: Task, at: number): Promise<string | null> {
  if (author.kind !== 'task') {
    return null
  }
  const since = new Date(at - TEAM_LOOP.windowMs).toISOString()
  return (await teamMessages.exchangesSince(author.taskId, task.id, since)) > TEAM_LOOP.exchanges ? 'loop' : null
}

async function holdReason(author: TeamAuthor, task: Task, at: number): Promise<string | null> {
  if (!paced(author)) {
    return null
  }
  const since = new Date(at - TEAM_BURST.windowMs).toISOString()
  return (await teamDeliveries.fromAgentsSince(task.id, since)) >= TEAM_BURST.deliveries ? 'burst' : null
}

function inputFor(message: TeamMessage, kind: TeamInput['kind']): TeamInput {
  const from = authorLabel(message)
  const who = speakerOf(message)
  const title =
    kind === 'direct' ? `${who} sent you a direct message` : `${who} in the group chat: ${oneLine(message.text)}`
  return {
    source: 'team',
    kind,
    message_id: message.id,
    subject: from,
    title: clip(title, TITLE_CHARS),
    body: message.text,
    url: null,
  }
}

/** Records the message in the task's transcript and hands it to the agent as the plan says. */
async function handOver(message: TeamMessage, target: Plan): Promise<Pick<TeamDelivery, 'mode' | 'reason'>> {
  if (target.skip !== null) {
    return { mode: 'skipped', reason: target.skip }
  }
  return inLane(target.task.id, async () => {
    await appendMessage(target.task.id, { kind: 'input', payload: inputFor(message, target.kind) })
    if (target.hold !== null) {
      return { mode: 'held', reason: target.hold }
    }
    try {
      const running = isRunning(target.task.id)
      if (!running && !target.startIdle) {
        return { mode: 'held', reason: 'idle' }
      }
      await runAutoTurn(target.task.id, target.priority)
      return { mode: running ? target.priority : 'start', reason: null }
    } catch (e) {
      return { mode: 'held', reason: e instanceof HttpError ? e.message : 'busy' }
    }
  })
}

const MODE_WORDS: Record<TeamDeliveryMode, string> = {
  now: 'joined the running turn of',
  next: 'reached at its next step',
  start: 'started a turn of',
  held: 'waits for the next turn of',
  skipped: 'was not handed to',
}

async function auditDelivery(message: TeamMessage, target: Plan, delivery: TeamDelivery): Promise<void> {
  const why = delivery.reason === null ? '' : ` (${delivery.reason})`
  await audit.record({
    actor: 'system',
    kind: 'team.message_delivered',
    subject_type: 'task',
    subject_id: target.task.id,
    summary: `Team message from ${authorLabel(message)} ${MODE_WORDS[delivery.mode]} task "${target.task.title}"${why}`,
    detail: {
      message_id: String(message.id),
      title: target.task.title,
      handle: delivery.handle,
      mode: delivery.mode,
      reason: delivery.reason,
    },
  })
}

async function notifyEa(message: TeamMessage): Promise<void> {
  const at = now()
  const from = authorLabel(message)
  const direct = isDirect(message)
  await eaInbox.add({
    kind: 'team_mention',
    event: direct ? 'direct' : 'mention',
    title: `${speakerOf(message)} ${direct ? 'sent you a direct message' : 'mentioned you in the group chat'}`,
    body: clip(message.text, INBOX_CHARS),
    url: null,
    severity: 'info',
    source: from === 'user' ? 'the user' : from,
    task_id: message.author_task_id,
    urgent: true,
    message_id: message.id,
    due_at: at,
    created_at: at,
  })
}

/** Handles the message mentions whose tasks are archived; they are handed nothing. */
async function archivedHandles(mentions: readonly TeamMention[]): Promise<string[]> {
  const handles: string[] = []
  for (const mention of mentions) {
    const task = mention.task_id === null ? undefined : await tasks.get(mention.task_id)
    if (task !== undefined && task.archived_at !== null) {
      handles.push(mention.handle)
    }
  }
  return handles
}

export async function handOverAll(message: TeamMessage, targets: readonly Plan[]): Promise<TeamDelivery[]> {
  const deliveries: TeamDelivery[] = []
  for (const target of targets) {
    const outcome = await handOver(message, target)
    const delivery: TeamDelivery = { task_id: target.task.id, handle: target.member.handle, ...outcome }
    await teamDeliveries.record({ ...delivery, message_id: message.id, author_kind: message.author_kind })
    await auditDelivery(message, target, delivery)
    deliveries.push(delivery)
  }
  return deliveries
}

/** Stores a message, shows it to those who may see it, and hands it to the tasks it reaches. */
export async function postTeamMessage(
  author: TeamAuthor,
  posted: string,
  options: { to?: string | undefined } = {},
): Promise<TeamPosted> {
  const fields = await authorFields(author)
  const text = stripSelfHeader(posted, fields.author_handle ?? fields.author_kind)
  if (options.to !== undefined) {
    return postDirect(author, { ...fields, text }, await recipientOf(author, options.to))
  }
  const { mentions, unknown } = await resolveMentions(parseMentions(text))
  const archived = await archivedHandles(mentions)
  const message = await teamMessages.insert({ ...fields, text, mentions })
  publishTeam({ type: 'message', message })
  await auditPost(author, message)
  if (author.kind !== 'ea' && mentions.some((mention) => mention.handle === 'ea')) {
    await notifyEa(message)
  }
  return { message, deliveries: await handOverAll(message, await plan(author, message, Date.now())), unknown, archived }
}

/** Stores a direct message and hands it to its one recipient, an agent or the EA. */
export async function postDirect(
  author: TeamAuthor,
  fields: AuthoredText,
  to: Recipient,
  replyTo?: number,
): Promise<TeamPosted> {
  const message = await teamMessages.insert({ ...fields, ...recipientFields(to), mentions: [recipientMention(to)] })
  publishTeam({ type: 'message', message })
  await auditDirect(message, replyTo)
  if (to.kind === 'ea') {
    await notifyEa(message)
    return { message, deliveries: [], unknown: [], archived: [] }
  }
  const target = await directPlan(author, to, replyTo !== undefined)
  return { message, deliveries: await handOverAll(message, [target]), unknown: [], archived: [] }
}
