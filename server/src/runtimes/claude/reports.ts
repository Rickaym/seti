import type { SDKCompactBoundaryMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { CONTEXT_WINDOW_KEY, projectClaude, type WithContextWindow } from '@seti/shared'
import { z } from 'zod'
import type { SessionMessage, SessionReport } from '../adapter.js'
import { refusalOf } from './resume.js'

type InputReport = Extract<SessionReport, { type: 'input' }>

const INPUT_STATES: readonly string[] = ['queued', 'started', 'cancelled'] satisfies InputReport['state'][]

const isInputState = (state: string): state is InputReport['state'] => INPUT_STATES.includes(state)

/** Claude Code's reports on the messages it queued, which the SDK types leave out. */
const commandLifecycle = z.object({
  type: z.literal('command_lifecycle'),
  command_uuid: z.string(),
  state: z.string(),
})

/** A message as Seti stores it: a session start without the tool, command and skill lists. */
export const storedForm = (m: SDKMessage): SDKMessage =>
  m.type === 'system' && m.subtype === 'init' ? { ...m, tools: [], slash_commands: [], skills: [] } : m

/** A compact boundary keeps the context window it was measured against, for its percentage. */
export async function withContextWindow(m: SDKMessage, window: () => Promise<number | null>): Promise<SDKMessage> {
  if (m.type !== 'system' || m.subtype !== 'compact_boundary') {
    return m
  }
  const tokens = await window()
  if (tokens === null) {
    return m
  }
  const stored: WithContextWindow<SDKCompactBoundaryMessage> = { ...m, [CONTEXT_WINDOW_KEY]: tokens }
  return stored
}

/** A message as Seti reads it: as stored, with its events and what the session half needs. */
function messageReport(m: SDKMessage): SessionMessage {
  const background =
    m.type === 'system' && m.subtype === 'background_tasks_changed'
      ? { background: m.tasks.filter((task) => task.ambient !== true).map((task) => task.task_id) }
      : {}
  return {
    type: 'message',
    raw: m,
    events: projectClaude(m),
    work: m.type !== 'system',
    byAgent: m.type === 'assistant' && m.parent_tool_use_id === null,
    delivered: m.type === 'result' ? (m.user_message_uuids ?? []) : [],
    ...background,
  }
}

/** The report of one message; null for thinking token estimates, which nothing shows. */
async function reportOf(m: SDKMessage, window: () => Promise<number | null>): Promise<SessionReport | null> {
  const queue = commandLifecycle.safeParse(m)
  if (queue.success) {
    const { command_uuid: id, state } = queue.data
    return { type: 'input', id, state: isInputState(state) ? state : 'other' }
  }
  if (m.type === 'system' && m.subtype === 'thinking_tokens') {
    return null
  }
  return messageReport(await withContextWindow(storedForm(m), window))
}

/** The report of one message, if it makes one. */
async function* reportsOf(m: SDKMessage, window: () => Promise<number | null>): AsyncGenerator<SessionReport> {
  const report = await reportOf(m, window)
  if (report !== null) {
    yield report
  }
}

/** The reports of a session that did not open at a rewind point. */
async function* plainReports(
  messages: AsyncIterable<SDKMessage>,
  window: () => Promise<number | null>,
): AsyncGenerator<SessionReport> {
  for await (const m of messages) {
    yield* reportsOf(m, window)
  }
}

type RewindReport = Extract<SessionReport, { type: 'rewind' }>

/** What a message says of the rewind: Claude Code refused it, or its session start applied it. */
function rewindOf(m: SDKMessage): RewindReport | null {
  const refused = refusalOf(m)
  if (refused !== null) {
    return { type: 'rewind', state: 'refused', reason: refused }
  }
  return m.type === 'system' && m.subtype === 'init' ? { type: 'rewind', state: 'applied' } : null
}

/**
 * The reports of a session opened at a rewind point: first whether Claude Code refused the
 * truncated resume, which ends them, or applied it.
 */
async function* rewoundReports(
  messages: AsyncIterable<SDKMessage>,
  window: () => Promise<number | null>,
): AsyncGenerator<SessionReport> {
  let applied = false
  try {
    for await (const m of messages) {
      const rewind = applied ? null : rewindOf(m)
      if (rewind !== null) {
        yield rewind
        if (rewind.state === 'refused') {
          return
        }
        applied = true
      }
      yield* reportsOf(m, window)
    }
  } catch (e) {
    const refused = !applied && e instanceof Error ? refusalOf(e) : null
    if (refused === null) {
      throw e
    }
    yield { type: 'rewind', state: 'refused', reason: refused }
  }
}

/** The reports of a Claude Code session's messages; `window` reads its context window. */
export const claudeReports = (
  messages: AsyncIterable<SDKMessage>,
  rewound: boolean,
  window: () => Promise<number | null>,
): AsyncIterable<SessionReport> => (rewound ? rewoundReports(messages, window) : plainReports(messages, window))
