import { z } from 'zod'

/** Whether a tool runs when asked, asks first, or acts only on the user's own yes. */
export const eaToolGate = z.enum(['runs', 'asks', 'word'])
export type EaToolGate = z.output<typeof eaToolGate>

/** One tool the EA's model is given, as its settings list it. */
export const eaTool = z.object({
  name: z.string(),
  area: z.string(),
  summary: z.string(),
  gate: eaToolGate,
})
export type EaTool = z.output<typeof eaTool>

/** What GET /api/ea/tools answers: the running EA's tools, or that nothing answers. */
export const eaToolsAnswer = z.union([
  z.object({ tools: z.array(eaTool) }),
  z.object({ running: z.literal(false), reason: z.string() }),
])
export type EaToolsAnswer = z.output<typeof eaToolsAnswer>
