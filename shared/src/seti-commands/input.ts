import { z } from 'zod'
import { SETI_LINE_MAX } from './parse.js'

/** A Seti command line the user submits from an agent's reply box, confirmed when it asks to be. */
export const setiCommandInput = z.object({
  line: z.string().max(SETI_LINE_MAX),
  confirmed: z.boolean().default(false),
})
export type SetiCommandInput = z.input<typeof setiCommandInput>

/** What a command did: its canonical line and Seti's words for it. */
export interface SetiCommandResult {
  line: string
  description: string
}
