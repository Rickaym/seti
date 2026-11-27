import { z } from 'zod'

/** One part of what the EA's model is told: system prompt, a channel's note or live context. */
export const eaPromptPart = z.object({
  key: z.enum(['base', 'call', 'chat', 'inbox', 'live']),
  label: z.string(),
  about: z.string(),
  text: z.string(),
  chars: z.number().int().nonnegative(),
  per_turn: z.boolean(),
  built_at: z.string().nullable(),
})
export type EaPromptPart = z.output<typeof eaPromptPart>

/** What GET /api/ea/prompt answers: the running EA's prompt parts and commit, or that it is down. */
export const eaPromptAnswer = z.union([
  z.object({ commit: z.string().nullable(), parts: z.array(eaPromptPart) }),
  z.object({ running: z.literal(false), reason: z.string() }),
])
export type EaPromptAnswer = z.output<typeof eaPromptAnswer>
