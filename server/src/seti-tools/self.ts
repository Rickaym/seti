import { statusLineText } from '@seti/shared'
import { tasks } from '../db.js'
import { done, setiTool } from './tool.js'

const setStatus = setiTool({
  name: 'set_status',
  description:
    'Show a short live status on your own row in Seti, such as "waiting on CI" or "running e2e", so the ' +
    'user sees what a long wait is for. An empty text clears it. Seti clears it when your turn ends, ' +
    'unless background work you started still runs, and when your next turn starts.',
  input: { text: statusLineText.describe('Plain text, at most 60 characters; empty clears it.') },
  run: async ({ text }, ctx) => {
    const line = text.replace(/\s+/g, ' ')
    await tasks.setStatusLine(ctx.caller.id, line === '' ? null : line)
    return done(line === '' ? 'Cleared your status.' : `Your status reads: ${line}`)
  },
})

/** Tools every agent gets at any Seti control level: they change only the calling agent's own row. */
export const SELF_TOOLS = [setStatus]
