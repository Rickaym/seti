import { z } from 'zod'

const text = z.looseObject({ type: z.literal('text'), text: z.string() })

/** A chunk of a message or a thought: text, or a part Seti shows only by its type. */
const chunk = z.looseObject({ content: z.union([text, z.looseObject({ type: z.string() })]) })

/** What a tool call shows: text, a file's change, or a terminal the client would host. */
const callContent = z.union([
  z.looseObject({ type: z.literal('content'), content: z.union([text, z.looseObject({ type: z.string() })]) }),
  z.looseObject({
    type: z.literal('diff'),
    path: z.string(),
    oldText: z.string().nullable().optional(),
    newText: z.string(),
  }),
  z.looseObject({ type: z.string() }),
])

/** The fields a tool call and its updates share; an update repeats only what changed. */
const callFields = {
  toolCallId: z.string(),
  title: z.string().optional(),
  kind: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional(),
  content: z.array(callContent).optional(),
  locations: z.array(z.looseObject({ path: z.string(), line: z.number().nullable().optional() })).optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
}

const planEntry = z.looseObject({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

/** One `session/update` as an ACP agent sends it, for the kinds Seti reads. */
export const sessionUpdate = z.discriminatedUnion('sessionUpdate', [
  chunk.extend({ sessionUpdate: z.literal('agent_message_chunk') }),
  chunk.extend({ sessionUpdate: z.literal('agent_thought_chunk') }),
  chunk.extend({ sessionUpdate: z.literal('user_message_chunk') }),
  z.looseObject({ sessionUpdate: z.literal('tool_call'), ...callFields }),
  z.looseObject({ sessionUpdate: z.literal('tool_call_update'), ...callFields }),
  z.looseObject({ sessionUpdate: z.literal('plan'), entries: z.array(planEntry) }),
])

/** The tokens a prompt's reply reports for its whole turn. */
interface PromptUsage {
  inputTokens: number
  outputTokens: number
  cachedReadTokens?: number | null
  cachedWriteTokens?: number | null
  thoughtTokens?: number | null
}

/**
 * An ACP agent's message as Seti stores it: the session it started, a prompt's turn starting,
 * one update (a message or a thought with its chunks joined, under the id Seti gave it; `denied`
 * when Seti refused the call it ends), or the end of the turn with its reply's text and tokens.
 */
export type AcpRecord =
  | { seti: 'started'; sessionId: string; model: string; cwd: string }
  | { seti: 'turn'; turnId: string }
  | { seti: 'update'; id: string; update: unknown; denied?: true }
  | {
      seti: 'ended'
      turnId: string
      stopReason: string
      result: string
      usage: PromptUsage | null
      /** Seti's estimate of the turn's cost from the provider's dated prices, where it has one. */
      usd?: number
      error?: string
      /** The calls the turn left without an end, as a cancel cuts them. */
      unfinished?: readonly string[]
    }

/** A tool call or an update of one, with the fields both carry. */
export type AcpToolCall = Extract<z.infer<typeof sessionUpdate>, { toolCallId: string }>
