import { statusLineText } from '@seti/shared'
import { z } from 'zod'
import { tasks } from '../db.js'
import { setTaskCwd } from '../task-location.js'
import { liveTask } from './refs.js'
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

const setWorkingDirectory = setiTool({
  name: 'set_working_directory',
  description:
    'Move your session into a directory inside your own folders, such as a repo you cloned, so Claude ' +
    "Code loads that repo's .mcp.json, settings, hooks and commands. Your folders stay yours and your " +
    'conversation carries on there from your next turn. A directory outside your folders is refused.',
  input: { path: z.string().trim().min(1).describe('An absolute path, or one relative to where you work now.') },
  run: async ({ path: wanted }, ctx) => {
    const cwd = await setTaskCwd(await liveTask(ctx.caller.id), wanted)
    return done(`Your session runs in ${cwd} from your next turn and keeps its conversation.`)
  },
})

/** Tools every agent gets at any Seti control level: they change only the calling agent itself. */
export const SELF_TOOLS = [setStatus, setWorkingDirectory]
