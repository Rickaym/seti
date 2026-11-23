import { z } from 'zod'
import {
  askFrame,
  askReply,
  journalAppend,
  journalReply,
  NODE_COMMANDS,
  sessionChanged,
  type NodeCommandType,
} from './node-protocol.js'

/** The version of these frames; a node and a control plane of other versions refuse each other. */
export const NODE_PROTOCOL = 1

const agent = z.string().min(1).max(64)
const id = z.uuid()

/** Where one agent's journal stands on the node, so the control plane can check and resume it. */
const journalPosition = z.object({ agent, epoch: z.string().min(1).max(64), acked: z.int(), last: z.int() })

/** The node introduces itself as the link comes up, with the sessions it runs right now. */
export const helloFrame = z.object({
  type: z.literal('hello'),
  protocol: z.int(),
  build: z.string().max(200),
  boot: id,
  /** The node's process, whose children are the agents' processes on this machine. */
  pid: z.int().positive(),
  /** No control plane welcomed this node process yet: the sessions of an earlier one are gone. */
  fresh: z.boolean(),
  journals: z.array(journalPosition),
  /** The asks the node still waits on, which go out again once it is welcomed. */
  asks: z.array(id),
  sessions: z.array(z.object({ agent, state: sessionChanged, since: z.int().nullable() })),
})
export type HelloFrame = z.infer<typeof helloFrame>

/** The control plane takes the node, with where it stands in each journal. */
export const welcomeFrame = z.object({
  type: z.literal('welcome'),
  protocol: z.int(),
  cursors: z.array(z.object({ agent, epoch: z.string().min(1).max(64), seq: z.int() })),
})

const commandType = z.enum(Object.keys(NODE_COMMANDS) as [NodeCommandType, ...NodeCommandType[]])

/** The control plane tells the node to act; the body is checked against the command's schema. */
export const commandFrame = z.object({ type: z.literal('command'), id, command: commandType, body: z.unknown() })
export type CommandFrame = z.infer<typeof commandFrame>

/** The commanded agent's last journal entry as the node answered; null when it has none. */
const answeredAfter = z.object({ agent, epoch: z.string().min(1).max(64), seq: z.int() }).nullable()

/** The node's answer to a command, or why it could not act. */
export const commandReply = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command.answer'), id, answer: z.unknown(), after: answeredAfter }),
  z.object({ type: z.literal('command.error'), id, error: z.string(), after: answeredAfter }),
])
export type CommandReply = z.infer<typeof commandReply>

/** The node stopped waiting for an ask's answer. */
export const askCancel = z.object({ type: z.literal('ask.cancel'), id })
export type AskCancel = z.infer<typeof askCancel>

/** Everything a node sends the control plane. */
export const nodeFrame = z.discriminatedUnion('type', [
  helloFrame,
  journalAppend,
  askFrame,
  askCancel,
  ...commandReply.options,
  /** The node is stopping: the control plane records the running turns the node then cuts. */
  z.object({ type: z.literal('node.stopping') }),
])
export type NodeFrame = z.infer<typeof nodeFrame>

/** Everything the control plane sends a node. */
export const controlFrame = z.discriminatedUnion('type', [
  welcomeFrame,
  ...journalReply.options,
  ...askReply.options,
  commandFrame,
  /** The control plane recorded the turns a stopping node cuts. */
  z.object({ type: z.literal('node.stop') }),
  z.object({ type: z.literal('refused'), reason: z.string() }),
])
export type ControlFrame = z.infer<typeof controlFrame>
