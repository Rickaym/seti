import { z } from 'zod'

/** How a question is answered: a pick between options, or Yes/No buttons for a yes/no pair. */
export const QUESTION_KINDS = ['choice', 'yes_no'] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

/** Open questions hold their agent's tool call; the rest are settled. */
export const QUESTION_STATUSES = ['open', 'answered', 'dismissed', 'expired'] as const
export type QuestionStatus = (typeof QUESTION_STATUSES)[number]

/** Who answered: the user in Seti, or the EA passing on what the user said. */
export const QUESTION_ANSWERERS = ['user', 'ea'] as const
export type QuestionAnswerer = (typeof QUESTION_ANSWERERS)[number]

export const QUESTION_HEADER_MAX = 60
export const QUESTION_PROMPT_MAX = 4000
export const QUESTION_OPTIONS_MAX = 8
export const QUESTION_LABEL_MAX = 200
export const QUESTION_DESCRIPTION_MAX = 1000
/** The longest answer in the user's own words. */
export const QUESTION_OTHER_MAX = 2000
/** The most questions one Submit all sends. */
export const QUESTIONS_PER_SUBMIT = 100

export interface QuestionOption {
  label: string
  description: string | null
}

/** The options the user picked and their own words, if any. */
export interface QuestionAnswer {
  selected: string[]
  other: string | null
}

/** One question an agent asked through AskUserQuestion; its group is the one tool call. */
export interface Question {
  id: string
  group_id: string
  task_id: string
  task_title: string
  /** The subagent that asked, or null for the agent itself. */
  subagent_id: string | null
  tool_use_id: string
  position: number
  header: string
  prompt: string
  kind: QuestionKind
  multi: boolean
  options: QuestionOption[]
  status: QuestionStatus
  answer: QuestionAnswer | null
  answered_by: QuestionAnswerer | null
  created_at: string
  settled_at: string | null
}

const NO = new Set(['no', 'nope'])
const YES = new Set(['yes', 'yep'])

const plainLabel = (label: string) => {
  const text = label.trim().toLowerCase()
  return text.endsWith('.') || text.endsWith('!') ? text.slice(0, -1) : text
}

/** Whether the options are exactly a yes and a no, which the UI shows as Yes/No buttons. */
export function isYesNo(options: readonly Pick<QuestionOption, 'label'>[]): boolean {
  const labels = options.map((option) => plainLabel(option.label))
  return labels.length === 2 && labels.some((label) => YES.has(label)) && labels.some((label) => NO.has(label))
}

/** The answer as one line: the picked options, then the user's own words. */
export function answerText(answer: QuestionAnswer): string {
  return [...answer.selected, ...(answer.other === null ? [] : [answer.other])].join(', ')
}

const otherText = z
  .string()
  .trim()
  .max(QUESTION_OTHER_MAX)
  .nullable()
  .default(null)
  .transform((text) => (text === '' ? null : text))

export const questionAnswerItem = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('answer'),
    id: z.uuid(),
    selected: z.array(z.string().min(1).max(QUESTION_LABEL_MAX)).max(QUESTION_OPTIONS_MAX).default([]),
    other: otherText,
  }),
  z.object({ action: z.literal('dismiss'), id: z.uuid() }),
])
export type QuestionAnswerItem = z.infer<typeof questionAnswerItem>

/** Answers and dismissals sent in one go, as Submit all and the EA send them. */
export const answerQuestionsInput = z.object({
  items: z.array(questionAnswerItem).min(1).max(QUESTIONS_PER_SUBMIT),
})
export type AnswerQuestionsInput = z.infer<typeof answerQuestionsInput>

/** What one send did: how many it answered and dismissed, and the agents it let go on. */
export interface AnswerQuestionsResult {
  answered: number
  dismissed: number
  /** Questions that were no longer open, as when their agent stopped waiting. */
  skipped: number
  /** Agents whose every question is now settled, so their tool call went back to them. */
  resumed: { task_id: string; task_title: string }[]
}

export const questionListQuery = z.object({
  task_id: z
    .string()
    .regex(/^[\w-]{1,100}$/)
    .optional(),
  /** Every status, newest first, for one agent's transcript; open ones oldest first otherwise. */
  all: z.enum(['true', 'false']).optional(),
})
