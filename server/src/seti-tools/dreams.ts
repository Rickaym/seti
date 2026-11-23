import { z } from 'zod'
import { startDream } from '../dreams/start.js'
import { dreamRuns } from '../store/dreams.js'
import { liveTask, taskRef } from './refs.js'
import { done, notSelf, setiTool } from './tool.js'

const SHOWN = 5

const dreamAgent = setiTool({
  name: 'dream_agent',
  description:
    "Another agent's recent dreams: how each ended, what it changed and its report. With start, run one dream of it now: a sandboxed session that tidies its memory folder and changes nothing else.",
  input: {
    task: taskRef,
    start: z.boolean().optional().describe('true to start a dream of the agent now'),
  },
  run: async ({ task: ref, start }, ctx) => {
    const task = await liveTask(ref)
    if (start === true) {
      notSelf(ctx, task, 'start a dream of')
      const run = await startDream(task)
      return done(`Started a dream of ${task.title} (run ${String(run.id)}); its report comes when it ends.`)
    }
    return (await dreamRuns.forTask(task.id, SHOWN)).map(
      ({ id, night, state, reason, memory_changes, cost_usd, report }) => ({
        id,
        night,
        state,
        reason,
        memory_changes,
        cost_usd,
        report,
      }),
    )
  },
})

export const DREAM_TOOLS = [dreamAgent]
