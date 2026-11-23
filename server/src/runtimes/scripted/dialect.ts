import { z } from 'zod'

const thread = z.string().optional()

const call = z.object({ id: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()) })

/** A tool call as the scripted runtime writes it: its own tool name and arguments. */
export type ScriptedCall = z.infer<typeof call>

const tokens = z.object({ in: z.number(), out: z.number() })

/** The lines the scripted runtime writes that the transcript keeps, by their `t`. */
export const conversationLines = {
  hello: z.object({ t: z.literal('hello'), session: z.string(), model: z.string(), resumed: z.boolean() }),
  begin: z.object({ t: z.literal('begin'), turn: z.string(), inputs: z.array(z.string()) }),
  say: z.object({ t: z.literal('say'), id: z.string(), text: z.string(), thread }),
  think: z.object({ t: z.literal('think'), id: z.string(), text: z.string(), thread }),
  call: z.object({ t: z.literal('call'), call, thread }),
  done: z.object({
    t: z.literal('done'),
    id: z.string(),
    status: z.enum(['ok', 'error', 'denied', 'cancelled']),
    output: z.string(),
    exit: z.number().optional(),
    thread,
  }),
  job: z.object({
    t: z.literal('job'),
    job: z.string(),
    call: z.string(),
    label: z.string(),
    phase: z.enum(['start', 'end']),
    status: z.enum(['completed', 'failed', 'stopped']).optional(),
  }),
  end: z.object({
    t: z.literal('end'),
    turn: z.string(),
    status: z.enum(['ok', 'error', 'interrupted']),
    reply: z.string(),
    inputs: z.array(z.string()),
    tokens,
    usd: z.number(),
  }),
}

type Lines = typeof conversationLines

/** A line the transcript keeps, once it parsed. */
export type ScriptedLine = { [T in keyof Lines]: z.infer<Lines[T]> }[keyof Lines]

/** A line only the driver reads: a request from the runtime, or its answer to a command. */
export const controlLine = z.discriminatedUnion('t', [
  z.object({ t: z.literal('request'), rid: z.number(), call }),
  z.object({ t: z.literal('withdraw'), rid: z.number() }),
  z.object({
    t: z.literal('ack'),
    rid: z.number(),
    ok: z.boolean(),
    error: z.string().optional(),
    taken: z.boolean().optional(),
  }),
])

export type ControlLine = z.infer<typeof controlLine>

/** What the driver answers a request: run the call, maybe with other arguments, or refuse it. */
export type Verdict = { allow: true; args?: Record<string, unknown> } | { allow: false; message: string }

/** What the driver writes to the scripted runtime, one JSON object per line. */
export type ScriptedCommand =
  | { t: 'open'; resume: string | null; cwd: string }
  | { t: 'input'; id: string; text: string }
  | { t: 'interrupt'; rid: number }
  | { t: 'retract'; rid: number; id: string }
  | { t: 'stop'; rid: number; job: string }
  | { t: 'verdict'; rid: number; verdict: Verdict }
