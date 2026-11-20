import { z } from 'zod'

/** The protocol version this build speaks best; it also speaks the one before. */
export const NODE_PROTOCOL_VERSION = 1

const id = z.string().min(1).max(200)
const agent = z.string().min(1).max(128)
const seq = z.int().min(0)
const features = z.array(z.string().min(1).max(100)).max(200)

/** The versions one side speaks, both ends included. */
export const protocolRange = z
  .object({ min: z.int().min(1), max: z.int().min(1) })
  .refine((range) => range.min <= range.max, 'min is above max')
export type ProtocolRange = z.output<typeof protocolRange>

/** This build's range: the current version and the previous one. */
export const NODE_PROTOCOL_RANGE: ProtocolRange = {
  min: Math.max(1, NODE_PROTOCOL_VERSION - 1),
  max: NODE_PROTOCOL_VERSION,
}

/** How far the control plane has stored one agent's journal. */
export const journalCursor = z.object({ epoch: z.string().min(1).max(200), seq })
export type JournalCursor = z.output<typeof journalCursor>

export const journalEntry = z.object({
  seq: z.int().min(1),
  at: z.int().min(0),
  type: z.string().min(1).max(100),
  body: z.unknown(),
})
export type JournalEntry = z.output<typeof journalEntry>

/** Every message carries the version it is written in, its type and an id. */
function message<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ v: z.int().min(1), type: z.literal(type), id, ...shape })
}

/** A reply that answers the message with the same `id`. */
function outcome<T extends string>(type: T) {
  return z.union([
    message(type, { ok: z.literal(true), body: z.unknown() }),
    message(type, { ok: z.literal(false), error: z.string().max(4000) }),
  ])
}

const hello = message('hello', {
  node: id,
  boot: id,
  protocol: protocolRange,
  features,
  clock: z.int().min(0),
  sessions: z.record(z.string(), z.unknown()),
})

const welcome = message('welcome', {
  version: z.int().min(1),
  features,
  cursors: z.record(agent, journalCursor),
})

const journalAppend = message('journal.append', {
  agent,
  epoch: z.string().min(1).max(200),
  first: z.int().min(1),
  entries: z.array(journalEntry).min(1),
}).refine(
  (batch) => batch.entries.every((entry, index) => entry.seq === batch.first + index),
  'entries are not consecutive from first',
)

const NODE_MESSAGES = {
  hello,
  welcome,
  ping: message('ping', {}),
  pong: message('pong', {}),
  bye: message('bye', { reason: z.string().max(500) }),
  'journal.append': journalAppend,
  'journal.ack': message('journal.ack', { agent, epoch: z.string().min(1).max(200), seq }),
  'journal.reject': message('journal.reject', {
    agent,
    reason: z.string().max(500),
    first: z.int().min(1).optional(),
    cursor: journalCursor.optional(),
  }),
  command: message('command', {
    kind: z.string().min(1).max(100),
    agent: agent.optional(),
    body: z.unknown(),
  }),
  'command.result': outcome('command.result'),
  ask: message('ask', { kind: z.string().min(1).max(100), agent, body: z.unknown() }),
  'ask.answer': message('ask.answer', { body: z.unknown() }),
  'ask.cancel': message('ask.cancel', {}),
  'ask.abort': message('ask.abort', {}),
  state: message('state', { agent: agent.optional(), version: z.int().min(0), body: z.unknown() }),
  request: message('request', {
    kind: z.string().min(1).max(100),
    agent: agent.optional(),
    body: z.unknown(),
  }),
  response: outcome('response'),
}

export type NodeMessageType = keyof typeof NODE_MESSAGES
export type NodeMessage = { [K in NodeMessageType]: z.output<(typeof NODE_MESSAGES)[K]> }[NodeMessageType]
export type NodeMessageOf<T extends NodeMessageType> = Extract<NodeMessage, { type: T }>

/** A message as read: known and valid, of a type this build does not know, or broken. */
export type DecodedNodeMessage =
  | { kind: 'message'; message: NodeMessage }
  | { kind: 'unsupported'; type: string; id: string }
  | { kind: 'invalid'; error: string }

const envelope = z.object({ v: z.int().min(1), type: z.string().min(1).max(100), id })

const isKnownType = (type: string): type is NodeMessageType => Object.hasOwn(NODE_MESSAGES, type)

/** Reads one JSON message; unknown fields are dropped and nothing here throws. */
export function decodeNodeMessage(text: string): DecodedNodeMessage {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'invalid', error: 'not JSON' }
  }
  const head = envelope.safeParse(value)
  if (!head.success) {
    return { kind: 'invalid', error: 'no envelope' }
  }
  const { type } = head.data
  if (!isKnownType(type)) {
    return { kind: 'unsupported', type, id: head.data.id }
  }
  const parsed = NODE_MESSAGES[type].safeParse(value)
  if (!parsed.success) {
    return { kind: 'invalid', error: `${type}: ${parsed.error.issues[0]?.message ?? 'invalid'}` }
  }
  return { kind: 'message', message: parsed.data }
}

/** What both sides speak: the highest common version and the shared features, or nothing. */
export type ProtocolAgreement = { kind: 'agreed'; version: number; features: string[] } | { kind: 'incompatible' }

interface ProtocolOffer {
  protocol: ProtocolRange
  features: readonly string[]
}

export function negotiateProtocol(local: ProtocolOffer, remote: ProtocolOffer): ProtocolAgreement {
  const version = Math.min(local.protocol.max, remote.protocol.max)
  if (version < Math.max(local.protocol.min, remote.protocol.min)) {
    return { kind: 'incompatible' }
  }
  const theirs = new Set(remote.features)
  return { kind: 'agreed', version, features: local.features.filter((name) => theirs.has(name)) }
}
