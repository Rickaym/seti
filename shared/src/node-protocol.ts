import { z } from 'zod'
import { TASK_STATUSES } from './tasks.js'

/** An attachment of a message the node hands its session, as the agent's workspace holds it. */
const promptAttachment = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(['text', 'image', 'file']),
  type: z.string(),
  mime: z.string(),
  size: z.number(),
  lines: z.number().nullable(),
  shown: z.boolean(),
  reference: z.string(),
})

/** A message waiting for its session: what the user or Seti sent, and how it goes out. */
const nextMessage = z.object({
  prompt: z.string().nullable(),
  attachments: z.array(promptAttachment).exactOptional(),
  interrupted: z.boolean(),
  retry: z.boolean().exactOptional(),
  client_id: z.string().exactOptional(),
  from: z.string().exactOptional(),
  priority: z.enum(['now', 'next']).exactOptional(),
  held: z.boolean().exactOptional(),
})

/**
 * What a node reports about one agent's session, in the order it happened. A runtime's message
 * travels as the runtime wrote it; the control plane decides what it means.
 */
export const journalEntry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), runtime: z.enum(['claude']), payload: z.unknown() }),
  z.object({ type: z.literal('turn.started') }),
  z.object({ type: z.literal('turn.ended'), status: z.enum(TASK_STATUSES), error: z.string().nullable() }),
  z.object({ type: z.literal('note'), error: z.string() }),
  z.object({ type: z.literal('queued.settled'), promptId: z.int(), state: z.enum(['delivered', 'removed']) }),
  z.object({ type: z.literal('session.opened') }),
  z.object({ type: z.literal('session.since'), promptId: z.int() }),
  z.object({ type: z.literal('session.closed'), since: z.int().nullable() }),
  z.object({ type: z.literal('session.state'), open: z.boolean(), background: z.int().nonnegative() }),
])
export type JournalEntry = z.infer<typeof journalEntry>

const askSchemas = {
  /** Records the prompt row of a message going out, or queued when a turn runs. */
  'prompt.open': {
    ask: z.object({ next: nextMessage, queued: z.boolean() }),
    answer: z.object({ promptId: z.int(), text: z.string() }),
  },
}
export type NodeAskType = keyof typeof askSchemas
export type NodeAsk<K extends NodeAskType> = z.infer<(typeof askSchemas)[K]['ask']>
export type NodeAnswer<K extends NodeAskType> = z.infer<(typeof askSchemas)[K]['answer']>

/** What a node asks the control plane and waits for, with the answer each ask gets. */
export const NODE_ASKS: {
  [K in NodeAskType]: { ask: z.ZodType<NodeAsk<K>>; answer: z.ZodType<NodeAnswer<K>> }
} = askSchemas
