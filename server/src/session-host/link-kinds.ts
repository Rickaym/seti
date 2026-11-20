import type { PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { SessionView } from '../agent-session.js'
import type { NextMessage } from '../next-message.js'
import type { PermissionSettings } from '../permission-policy.js'

/** A JSON object whose fields the receiving side reads through the types it was sent as. */
const record = <T>() => z.custom<T>((value) => typeof value === 'object' && value !== null)

const promptId = z.number().int().nonnegative()
const queueEnd = z.enum(['delivered', 'removed'])
const taskStatus = z.enum(['idle', 'running', 'error', 'stopped', 'interrupted'])
const view = record<SessionView>().nullable()

/** Each journal entry a node writes for an agent, by type, with its body. */
export const JOURNAL_ENTRIES = {
  sdk: z.object({ message: record<SDKMessage>(), contextWindow: z.number().nullable().optional() }),
  queued: z.object({ promptId, state: queueEnd }),
  working: z.object({}),
  'turn.ended': z.object({ status: taskStatus, error: z.string().nullable() }),
  note: z.object({ error: z.string() }),
  rewound: z.object({ rewindId: z.number().int(), refused: z.string().nullable() }),
  'warm.opened': z.object({}),
  'session.changed': z.object({}),
  'session.ended': z.object({}),
  'session.closed': z.object({ since: promptId.nullable() }),
  view: z.object({ view }),
  unstarted: z.object({ kept: z.object({ first: z.string().nullable() }).nullable() }),
}
export type JournalType = keyof typeof JOURNAL_ENTRIES

/** What the node asks the records side for a session; each waits for the journal up to `after`. */
export const PORT_ASKS = {
  'turn.open': z.object({ next: record<NextMessage>(), queued: z.boolean(), after: z.number().int() }),
  'session.spec': z.object({ after: z.number().int() }),
  'task.exists': z.object({ after: z.number().int() }),
  'session.opening': z.object({ after: z.number().int() }),
}
export type PortAsk = keyof typeof PORT_ASKS

const check = z.object({ rewind: z.boolean(), key: z.string().nullable() }).nullable()

/** What the records side tells the node to do, by command kind, with its body. */
export const COMMANDS = {
  start: z.object({
    message: record<Omit<NextMessage, 'interrupted'>>(),
    interrupt: z.boolean(),
    check,
  }),
  open_warm: z.object({}),
  stop: z.object({ deliverQueued: z.boolean() }),
  end: z.object({}),
  close_idle: z.object({}),
  stop_task: z.object({ sdkTaskId: z.string().max(200) }),
  cancel_queued: z.object({ promptId }),
  set_mode: z.object({ mode: z.custom<PermissionMode>((value) => typeof value === 'string') }),
  apply_permissions: z.object({ permissions: record<PermissionSettings>() }),
  restart_quiet: z.object({ at: z.number().optional() }),
  mcp_status: z.object({}),
}
export type CommandKind = keyof typeof COMMANDS

/** A command's result: its answer and how far the agent's journal reached once it was done. */
export interface CommandDone {
  body: unknown
  seq: number
}
