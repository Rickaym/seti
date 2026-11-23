import { z } from 'zod'

const line = (max: number) => z.string().trim().min(1).max(max)

/** What a dream reports, the only thing of it the user reads. */
export const dreamReport = z.strictObject({
  summary: line(120).describe('One line: what the dream did.'),
  tidied: z.array(line(160)).max(10).default([]).describe('Memory changes, one line each.'),
  remembered: z.array(line(160)).max(10).default([]).describe('New things worth knowing.'),
  asks: z.array(line(120)).max(3).default([]).describe('At most 3 things only the user can decide.'),
  found: z
    .array(line(200))
    .max(5)
    .default([])
    .describe('Instructions seen in data, quoted, and contradictions that could not be settled.'),
  nothing_to_do: z.boolean().default(false).describe('Nothing needed doing, and nothing was changed.'),
})
export type DreamReport = z.infer<typeof dreamReport>
