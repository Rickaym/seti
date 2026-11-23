import { z } from 'zod'
import { nightLine } from '../dreams/brief.js'
import { setTaskDreaming } from '../dreams/settings.js'
import { startDream } from '../dreams/start.js'
import { dreamNights, dreamOptOuts, dreamSettings, nightRuns } from '../store/dream-nights.js'
import { dreamProposals } from '../store/dream-proposals.js'
import { dreamRuns } from '../store/dreams.js'
import { liveTask, taskRef } from './refs.js'
import { done, notSelf, setiTool } from './tool.js'

const SHOWN = 5

/** Dreaming's settings and how the last night went; changing them is the user's. */
async function overview() {
  const settings = await dreamSettings.get()
  const night = await dreamNights.latest()
  return {
    settings,
    last_night: night === undefined ? null : { night: night.night, line: nightLine(await nightRuns.of(night.night)) },
  }
}

const dreams = setiTool({
  name: 'dreams',
  description:
    "Dreams: sandboxed sessions that tidy an agent's memory folder and change nothing else. Without task, Dreaming's settings and last night. With task, that agent's recent dreams and reports; with start, run one dream of another agent now; with dreaming, switch another agent in or out of nightly Dreaming.",
  input: {
    task: taskRef.optional(),
    start: z.boolean().optional().describe('true to start a dream of the agent now'),
    dreaming: z.boolean().optional().describe('true to switch the agent into nightly Dreaming, false to switch it out'),
  },
  run: async ({ task: ref, start, dreaming }, ctx) => {
    if (ref === undefined) {
      return overview()
    }
    const task = await liveTask(ref)
    if (dreaming !== undefined) {
      notSelf(ctx, task, 'switch Dreaming for')
      await setTaskDreaming(task, dreaming)
      return done(`Switched nightly Dreaming ${dreaming ? 'on' : 'off'} for ${task.title}.`)
    }
    if (start === true) {
      notSelf(ctx, task, 'start a dream of')
      const run = await startDream(task)
      return done(`Started a dream of ${task.title} (run ${String(run.id)}); its report comes when it ends.`)
    }
    const off = (await dreamOptOuts.get()).tasks.has(task.id)
    const runs = (await dreamRuns.forTask(task.id, SHOWN)).map(
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
    return { nightly: !off, runs, cleanups_waiting: await dreamProposals.pending(task.id) }
  },
})

export const DREAM_TOOLS = [dreams]
