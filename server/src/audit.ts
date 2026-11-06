import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  modActor,
  type AuditActor,
  type AuditDetail,
  type AuditEvent,
  type AuditKind,
  type AuditSubjectType,
  type ModAuditKind,
} from '@seti/shared'
import { anonymousRequest, currentRequestSource } from './access.js'
import type { SendOutcome } from './agent-session.js'
import { AUDIT_RETENTION_DAYS } from './config.js'
import { now, tasks } from './db.js'
import { outwardRecord } from './outward-detail.js'
import { scrubDetail, scrubSummary } from './scrub.js'
import { auditEvents } from './store/audit.js'
import { openCommand } from './tool-calls.js'

interface AuditInput {
  actor: AuditActor
  kind: AuditKind | ModAuditKind
  subject_type: AuditSubjectType
  subject_id?: string | null
  summary: string
  detail?: AuditDetail
  /** Detail text fields kept whole, line breaks and all, rather than cut to one short line. */
  long?: readonly string[]
}

const DAY_MS = 24 * 60 * 60 * 1000

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * User actions through Access name their identity, passkey sessions their passkey; EA ones and
 * requests with no credential say so. What an agent did with its seti tools is the agent's, and
 * what a mod did through the mod API is the mod's.
 */
function actorOf(input: AuditInput): { actor: AuditEvent['actor']; detail: AuditDetail } {
  const detail = input.detail ?? {}
  const source = input.actor === 'user' ? currentRequestSource() : null
  switch (source?.via) {
    case undefined:
      return input.actor === 'user' && anonymousRequest()
        ? { actor: input.actor, detail: { ...detail, via: 'anonymous' } }
        : { actor: input.actor, detail }
    case 'local':
      return { actor: input.actor, detail }
    case 'ea':
      return { actor: input.actor, detail: { ...detail, via: 'ea' } }
    case 'public':
      return { actor: input.actor, detail: { ...detail, via: 'public', access_identity: source.identity } }
    case 'session':
      return { actor: input.actor, detail: { ...detail, via: 'passkey', passkey: source.passkey } }
    case 'device':
      return { actor: input.actor, detail: { ...detail, via: 'device', device: source.name } }
    case 'agent':
      return { actor: 'agent', detail: { ...detail, via: 'seti_tools', agent_id: source.taskId, agent: source.title } }
    case 'mod':
      return { actor: modActor(source.modId), detail: { ...detail, via: 'mod', mod: source.modId } }
  }
}

/** Stores one scrubbed event; failures go to stderr and never reach the caller. */
async function record(input: AuditInput): Promise<void> {
  const { actor, detail } = actorOf(input)
  try {
    await auditEvents.insert({
      at: now(),
      actor,
      kind: input.kind,
      subject_type: input.subject_type,
      subject_id: input.subject_id ?? null,
      summary: scrubSummary(input.summary),
      detail: scrubDetail(detail, input.long),
    })
  } catch (e) {
    process.stderr.write(`audit: could not record ${input.kind}: ${errorText(e)}\n`)
  }
}

async function prune(at: Date = new Date(), days: number = AUDIT_RETENTION_DAYS): Promise<void> {
  try {
    await auditEvents.prune(new Date(at.getTime() - days * DAY_MS).toISOString())
  } catch (e) {
    process.stderr.write(`audit: could not prune: ${errorText(e)}\n`)
  }
}

/** Writes the chain head to the journal, which agents cannot rewrite, and flags a broken chain. */
async function checkChain(): Promise<void> {
  try {
    const status = await auditEvents.verify()
    process.stdout.write(`audit: chain head #${String(status.head_id)} ${status.head_hash}\n`)
    if (!status.ok) {
      process.stderr.write(`audit: chain broken at #${String(status.broken_at)}: ${status.problem ?? ''}\n`)
    }
  } catch (e) {
    process.stderr.write(`audit: could not verify the chain: ${errorText(e)}\n`)
  }
}

async function daily(): Promise<void> {
  await prune()
  await checkChain()
}

function startRetention(): void {
  void daily()
  setInterval(() => void daily(), DAY_MS).unref()
}

/** Records the tool calls of an assistant message that the runner flagged as outward. */
async function outwardCalls(taskId: string, m: SDKMessage, outwardIds: readonly string[]): Promise<void> {
  if (m.type !== 'assistant' || outwardIds.length === 0) {
    return
  }
  const title = (await tasks.get(taskId))?.title
  for (const block of m.message.content) {
    if (block.type === 'tool_use' && outwardIds.includes(block.id)) {
      const sent = outwardRecord(block.name, block.input)
      await record({
        actor: 'agent',
        kind: 'agent.outward',
        subject_type: 'task',
        subject_id: taskId,
        summary: sent.summary,
        detail: { tool: block.name, tool_use_id: block.id, ...(title === undefined ? {} : { title }), ...sent.detail },
        long: ['text', 'input'],
      })
    }
  }
}

/** Records a call auto mode's classifier turned down, which reaches no permission request. */
async function classifierDenial(taskId: string, m: SDKMessage): Promise<void> {
  if (m.type !== 'system' || m.subtype !== 'permission_denied' || m.decision_reason_type !== 'classifier') {
    return
  }
  const command = openCommand(taskId, m.tool_use_id)
  const call = command === null ? m.tool_name : `Bash: ${command}`
  const title = (await tasks.get(taskId))?.title ?? taskId
  await record({
    actor: 'system',
    kind: 'task.permission_denied',
    subject_type: 'task',
    subject_id: taskId,
    summary: `Auto mode turned down ${call} in task "${title}"`,
    detail: {
      title,
      tool: m.tool_name,
      tool_use_id: m.tool_use_id,
      ...(command === null ? {} : { command }),
      reason: m.decision_reason ?? null,
      classifier: true,
    },
  })
}

export const audit = { record, prune, checkChain, startRetention, outwardCalls, classifierDenial }

const TASK_VERBS = {
  'task.message_sent': 'Sent a message to',
  'task.queued_message_removed': 'Took back a queued message from',
  'task.stopped': 'Stopped',
  'task.subtask_stopped': 'Stopped a subagent of',
  'task.process_stopped': 'Stopped a process of',
  'task.session_ended': 'Stopped all background work of',
  'task.session_restarted': 'Restarted the session of',
  'task.deleted': 'Deleted',
} as const satisfies Partial<Record<AuditKind, string>>

export async function auditTask(
  kind: keyof typeof TASK_VERBS,
  task: { id: string; title: string },
  detail: AuditDetail = {},
): Promise<void> {
  await record({
    actor: 'user',
    kind,
    subject_type: 'task',
    subject_id: task.id,
    summary: `${TASK_VERBS[kind]} task "${task.title}"`,
    detail: { title: task.title, ...detail },
  })
}

/** Records a message the user sent, and whether it was queued for or stopped the running turn. */
export async function auditMessage(
  task: { id: string; title: string },
  prompt: string,
  outcome: SendOutcome,
  extra: AuditDetail = {},
): Promise<void> {
  if (outcome === 'started') {
    await auditTask('task.message_sent', task, { prompt, ...extra })
    return
  }
  const queued = outcome === 'queued'
  await record({
    actor: 'user',
    kind: 'task.message_sent',
    subject_type: 'task',
    subject_id: task.id,
    summary: queued
      ? `Queued a message for the running turn of task "${task.title}"`
      : `Interrupted the agent with a message to task "${task.title}"`,
    detail: { title: task.title, prompt, ...extra, ...(queued ? { queued: true } : { interrupted: true }) },
  })
}

const PR_PARTS = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/

function prFields(url: string): { label: string; detail: AuditDetail } {
  const [, slug, number] = PR_PARTS.exec(url) ?? []
  return { label: slug === undefined || number === undefined ? url : `${slug}#${number}`, detail: { url } }
}

export interface PrLinkChange {
  actor: AuditActor
  taskId: string
  url: string
  linked: boolean
  /** How Seti found a PR it linked on its own. */
  found?: string
  /** Why Seti unlinked a PR on its own. */
  reason?: string
  /** Seti unlinked it because it merged. */
  merged?: boolean
}

type PrLinkListener = (change: PrLinkChange) => void

const prLinkListeners: PrLinkListener[] = []

/** Hears each PR link and unlink as Seti records it, such as for mods' task events. */
export function onPrLinkChange(listener: PrLinkListener): void {
  prLinkListeners.push(listener)
}

export async function auditPrLink(change: PrLinkChange): Promise<void> {
  const { actor, taskId, url, linked, found, reason } = change
  const pr = prFields(url)
  const why = found ?? reason
  const suffix = why === undefined ? '' : ` (${why})`
  await record({
    actor,
    kind: linked ? 'task.pr_linked' : 'task.pr_unlinked',
    subject_type: 'task',
    subject_id: taskId,
    summary: `${linked ? 'Linked' : 'Unlinked'} PR ${pr.label}${suffix}`,
    detail: { ...pr.detail, ...(found === undefined ? {} : { found }), ...(reason === undefined ? {} : { reason }) },
  })
  for (const listener of prLinkListeners) {
    listener(change)
  }
}

/** A PR linked to or unlinked from one subagent of a task; the task keeps its own link. */
export async function auditSubtaskPrLink(
  change: Omit<PrLinkChange, 'found'> & { subtask: { tool_use_id: string; description: string } },
): Promise<void> {
  const { actor, taskId, url, linked, subtask } = change
  const pr = prFields(url)
  await record({
    actor,
    kind: linked ? 'task.subtask_pr_linked' : 'task.subtask_pr_unlinked',
    subject_type: 'task',
    subject_id: taskId,
    summary: `${linked ? 'Linked' : 'Unlinked'} PR ${pr.label} ${linked ? 'to' : 'from'} subagent "${subtask.description}"`,
    detail: { ...pr.detail, subtask: subtask.description, tool_use_id: subtask.tool_use_id },
  })
}
