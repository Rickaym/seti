import { z } from 'zod'

/** Longest question a side chat takes, in characters. */
export const SIDE_QUESTION_MAX = 4000

/** A side chat's or an aside's id, a random UUID the server picks. */
export const SIDE_CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The newest asides of one agent Seti lists, oldest first. */
export const ASIDE_LIST_MAX = 500

const question = z.string().trim().min(1, 'question is required').max(SIDE_QUESTION_MAX)

/** A question for an agent's side chat; with `chat_id` it follows up in that chat. */
export const sideChatInput = z.object({
  question,
  chat_id: z.string().regex(SIDE_CHAT_ID).optional(),
})
export type SideChatInput = z.input<typeof sideChatInput>

/** A one-off side question, answered whole in a chat of its own. */
export const sideQuestionInput = z.object({ question })
export type SideQuestionInput = z.input<typeof sideQuestionInput>

/** Who asked an aside: the user in Seti, the EA, or an agent through its Seti tools. */
export const ASIDE_ASKERS = ['user', 'ea', 'agent'] as const
export type AsideAsker = (typeof ASIDE_ASKERS)[number]

/**
 * One side question and its redacted answer, kept until the agent is deleted. It belongs to the
 * agent's transcript view only; the agent's session never sees it.
 */
export const aside = z.object({
  id: z.string(),
  task_id: z.string(),
  chat_id: z.string(),
  question: z.string(),
  answer: z.string(),
  asked_by: z.enum(ASIDE_ASKERS),
  /** The agent that asked, when an agent did. */
  asker_id: z.string().nullable(),
  asker_title: z.string().nullable(),
  cost_usd: z.number().nullable(),
  asked_at: z.string(),
  answered_at: z.string(),
})
export type Aside = z.infer<typeof aside>

/** An agent's asides, oldest first. */
export interface AsideList {
  asides: Aside[]
}

/**
 * What a side chat streams for one question: the chat it belongs to, the answer so far, the files
 * it reads, and how the answer ended. `text` always carries the whole answer so far, and `done`
 * carries the aside as Seti stored it.
 */
export const sideChatEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), chat_id: z.string() }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool'), text: z.string() }),
  z.object({ type: z.literal('done'), text: z.string(), cost_usd: z.number().nullable(), aside }),
  z.object({ type: z.literal('error'), error: z.string() }),
])
export type SideChatEvent = z.infer<typeof sideChatEvent>

/** A one-off side question's answer and what it cost, in US dollars when known. */
export interface SideAnswer {
  answer: string
  cost_usd: number | null
}
