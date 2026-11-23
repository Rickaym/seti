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
  z.object({ type: z.literal('session.started'), warm: z.boolean() }),
  z.object({ type: z.literal('guard.refused'), command: z.string(), reason: z.string() }),
  z.object({
    type: z.literal('rewind.settled'),
    id: z.int(),
    state: z.enum(['applied', 'refused']),
    reason: z.string().nullable(),
  }),
  z.object({ type: z.literal('session.since'), promptId: z.int() }),
  z.object({ type: z.literal('session.closed'), since: z.int().nullable() }),
  z.object({ type: z.literal('session.state'), open: z.boolean(), background: z.int().nonnegative() }),
  z.object({
    type: z.literal('session.changed'),
    open: z.boolean(),
    running: z.boolean(),
    accepting: z.boolean(),
    autoQueued: z.boolean(),
    background: z.int().nonnegative(),
  }),
])
export type JournalEntry = z.infer<typeof journalEntry>

/** A tool call of the agent, as the runtime hands it to a hook. */
const toolCall = z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()) })

const askSchemas = {
  /** Records the prompt row of a message going out, or queued when a turn runs. */
  'prompt.open': {
    ask: z.object({ next: nextMessage, queued: z.boolean() }),
    answer: z.object({ promptId: z.int(), text: z.string() }),
  },
  /** Runs what waits for the agent's process to start; the process starts after the answer. */
  'session.opening': { ask: z.object({}), answer: z.object({}) },
  /**
   * What the agent's process starts from: the spec, the key of its setup and the rewind point to
   * resume at. The spec is the control plane's and holds no secret values.
   */
  'session.spec': {
    ask: z.object({}),
    answer: z.object({
      spec: z.unknown(),
      key: z.string(),
      rewind: z.object({ id: z.int(), resume_at: z.string().nullable(), drops_turn: z.string().nullable() }).nullable(),
    }),
  },
  /**
   * The key of the setup the agent's process needs now, or that a rewind waits, which needs a new
   * process anyway. With the spec a process started from, the key is of that spec with its live
   * settings read again.
   */
  'setup.key': {
    ask: z.object({ spec: z.unknown() }),
    answer: z.discriminatedUnion('rewind', [
      z.object({ rewind: z.literal(true) }),
      z.object({ rewind: z.literal(false), key: z.string() }),
    ]),
  },
  /** Decides a tool call the runtime would ask about: the user answers a request or a question. */
  'permission.ask': {
    ask: z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()), options: z.unknown() }),
    answer: z.object({ result: z.unknown() }),
  },
  /** Holds an MCP call a review rule names until the user answers; the hook's output. */
  'review.ask': { ask: toolCall, answer: z.object({ output: z.unknown() }) },
  /** Asks the user about a call the agent repeats with the same result, `results` times so far. */
  'repeat.ask': {
    ask: toolCall.extend({ results: z.int().positive() }),
    answer: z.discriminatedUnion('outcome', [
      z.object({ outcome: z.literal('off') }),
      z.object({ outcome: z.literal('denied'), message: z.string() }),
      z.object({ outcome: z.literal('allowed'), always: z.boolean() }),
    ]),
  },
  /** The instructions the agent's compaction keeps, or null for the runtime's own. */
  'hook.compact': { ask: z.object({}), answer: z.object({ instructions: z.string().nullable() }) },
  /** The hosts a sandboxed agent may fetch from. */
  'sandbox.hosts': { ask: z.object({}), answer: z.object({ hosts: z.array(z.string()) }) },
  /** The tools Seti serves the agent's process itself, by MCP server, as each server lists them. */
  'tools.list': {
    ask: z.object({}),
    answer: z.object({
      servers: z.array(z.object({ name: z.string(), tools: z.array(z.looseObject({ name: z.string() })) })),
    }),
  },
  /** Runs one of those tools as the agent and answers its MCP result. */
  'tool.call': {
    ask: z.object({ server: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()) }),
    answer: z.object({ result: z.unknown() }),
  },
}
export type NodeAskType = keyof typeof askSchemas
export type NodeAsk<K extends NodeAskType> = z.infer<(typeof askSchemas)[K]['ask']>
export type NodeAnswer<K extends NodeAskType> = z.infer<(typeof askSchemas)[K]['answer']>

/** What a node asks the control plane and waits for, with the answer each ask gets. */
export const NODE_ASKS: {
  [K in NodeAskType]: { ask: z.ZodType<NodeAsk<K>>; answer: z.ZodType<NodeAnswer<K>> }
} = askSchemas

const agent = z.string().min(1).max(64)
const epoch = z.string().min(1).max(64)

/** A run of one agent's journal entries, numbered from `first`; the node sends it. */
export const journalAppend = z.object({
  type: z.literal('journal.append'),
  agent,
  epoch,
  first: z.int().positive(),
  entries: z.array(journalEntry).min(1),
})
export type JournalAppend = z.infer<typeof journalAppend>

/** What the control plane answers a run: stored up to `seq`, or refused with a reason. */
export const journalReply = z.discriminatedUnion('type', [
  z.object({ type: z.literal('journal.ack'), agent, epoch, seq: z.int().nonnegative() }),
  z.object({ type: z.literal('journal.reject'), agent, epoch, reason: z.string() }),
])
export type JournalReply = z.infer<typeof journalReply>

/** An ask in flight, with the id the node made, so a retried ask is answered once. */
export const askFrame = z.object({
  type: z.literal('ask'),
  id: z.uuid(),
  agent,
  ask: z.enum(Object.keys(askSchemas) as [NodeAskType, ...NodeAskType[]]),
  body: z.unknown(),
})
export type AskFrame = z.infer<typeof askFrame>

/** The control plane's answer to an ask, or why it could not answer. */
export const askReply = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ask.answer'), id: z.uuid(), answer: z.unknown() }),
  z.object({ type: z.literal('ask.error'), id: z.uuid(), error: z.string() }),
])
export type AskReply = z.infer<typeof askReply>

const done = z.object({})
const stopped = z.object({ stopped: z.boolean() })

const commandSchemas = {
  /** Hands the agent a message: it starts a turn, queues for the running one or cuts it short. */
  'turn.send': {
    body: z.object({ agent, message: nextMessage.omit({ interrupted: true }), interrupt: z.boolean() }),
    answer: z.object({ outcome: z.enum(['started', 'queued', 'interrupted']) }),
  },
  /** Cuts the running turn short and waits for its end; false when no turn ran. */
  'turn.stop': { body: z.object({ agent, deliverQueued: z.boolean() }), answer: stopped },
  /** Opens a process for an agent without one, so it is ready for the next turn. */
  'session.open': { body: z.object({ agent }), answer: done },
  /** Ends the agent's process and waits; with `onlyIdle`, only when nothing runs in it. */
  'session.close': { body: z.object({ agent, onlyIdle: z.boolean() }), answer: z.object({ closed: z.boolean() }) },
  /** How the MCP servers of the agent's open process connected; null when none is open. */
  'mcp.status': { body: z.object({ agent }), answer: z.object({ servers: z.array(z.unknown()).nullable() }) },
  /** Stops one subagent or background command in the agent's open process. */
  'background.stop': { body: z.object({ agent, task: z.string().min(1) }), answer: stopped },
  /** Switches the agent's open process to a permission mode; `next_turn` when it cannot now. */
  'mode.set': {
    body: z.object({ agent, mode: z.string() }),
    answer: z.object({ applied: z.enum(['now', 'next_turn']) }),
  },
  /** Hands the agent's open process the permission rules its task has now. */
  'policy.set': { body: z.object({ agent, policy: z.unknown() }), answer: done },
  /** Takes back a queued message before the agent reads it, and says how that went. */
  'queued.retract': {
    body: z.object({ agent, promptId: z.int() }),
    answer: z.object({ outcome: z.enum(['missing', 'unsupported', 'taken', 'removed']), promptId: z.int().nullable() }),
  },
  /** Starts the agent's quiet clock again, from `at` or from now. */
  'quiet.restart': { body: z.object({ agent, at: z.number().nullable() }), answer: done },
  /** The open sessions, with how long each has been quiet and why, and what their turn is. */
  'sessions.view': {
    body: done,
    answer: z.object({
      sessions: z.array(
        z.object({
          agent,
          open: z.boolean(),
          running: z.boolean(),
          heardAt: z.number(),
          retrying: z.string().nullable(),
          kind: z.enum(['user', 'updates', 'wake']),
          background: z.int().nonnegative(),
        }),
      ),
    }),
  },
  /**
   * Ends the agents' running turns as Seti stops: interrupted where the runtime can, else closed,
   * so the next start resumes them. Answers once they ended or `graceMs` passed.
   */
  'sessions.cut': { body: z.object({ agents: z.array(agent), graceMs: z.int().nonnegative() }), answer: done },
}
export type NodeCommandType = keyof typeof commandSchemas
export type NodeCommand<K extends NodeCommandType> = z.infer<(typeof commandSchemas)[K]['body']>
export type NodeReply<K extends NodeCommandType> = z.infer<(typeof commandSchemas)[K]['answer']>

/** What the control plane tells a node to do, with what the node answers. */
export const NODE_COMMANDS: {
  [K in NodeCommandType]: { body: z.ZodType<NodeCommand<K>>; answer: z.ZodType<NodeReply<K>> }
} = commandSchemas
