import { z } from 'zod'

/** Longest question a side chat takes, in characters. */
export const SIDE_QUESTION_MAX = 4000

/** Questions one side chat answers, its first included, before it has to be closed. */
export const SIDE_CHAT_TURNS = 8

/** A side chat's id, a random UUID the server picks when the chat starts. */
export const SIDE_CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const question = z.string().trim().min(1, 'question is required').max(SIDE_QUESTION_MAX)

/** A question for an agent's side chat; with `chat_id` it follows up in that chat. */
export const sideChatInput = z.object({
  question,
  chat_id: z.string().regex(SIDE_CHAT_ID).optional(),
})
export type SideChatInput = z.input<typeof sideChatInput>

/** A one-off side question, answered whole and then discarded. */
export const sideQuestionInput = z.object({ question })
export type SideQuestionInput = z.input<typeof sideQuestionInput>

/**
 * What a side chat streams for one question: the chat it belongs to, the answer so far, the files
 * it reads, and how the answer ended. `text` always carries the whole answer so far.
 */
export const sideChatEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), chat_id: z.string(), turns_left: z.number().int().nonnegative() }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool'), text: z.string() }),
  z.object({
    type: z.literal('done'),
    text: z.string(),
    cost_usd: z.number().nullable(),
    turns_left: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('error'), error: z.string() }),
])
export type SideChatEvent = z.infer<typeof sideChatEvent>

/** A one-off side question's answer and what it cost, in US dollars when known. */
export interface SideAnswer {
  answer: string
  cost_usd: number | null
}
