import { dreamNowInput, dreamSettingsInput, dreamToggle, type DreamNight } from '@seti/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { setTaskDreaming, setWorkspaceDreaming, updateDreamSettings } from '../dreams/settings.js'
import { startDream } from '../dreams/start.js'
import { refuseOnSelf } from '../ea-guard.js'
import { ok, valid, validJson } from '../http.js'
import { dreamNights, dreamOptOuts, dreamSettings, nightRuns } from '../store/dream-nights.js'
import { dreamRuns } from '../store/dreams.js'
import { requireTask } from '../tasks.js'

const LISTED = 14

const nightQuery = z.strictObject({ night: z.iso.date().optional() })

/** A night with its dreams and what they cost, the newest one when none is named. */
async function nightOf(name: string | undefined): Promise<DreamNight | null> {
  const night = name === undefined ? await dreamNights.latest() : await dreamNights.get(name)
  if (night === undefined) {
    return null
  }
  const runs = await nightRuns.of(night.night)
  return { ...night, runs, cost_usd: runs.reduce((sum, run) => sum + run.cost_usd, 0) }
}

export const taskDreamRoutes = new Hono()
  .get('/:id/dreams', async (c) => ok(c, await dreamRuns.forTask((await requireTask(c.req.param('id'))).id, LISTED)))
  .post('/:id/dream', validJson(dreamNowInput), async (c) => {
    const task = await requireTask(c.req.param('id'))
    refuseOnSelf(task.id, 'start a dream of')
    return ok(c, await startDream(task))
  })
  .put('/:id/dreaming', validJson(dreamToggle), async (c) => {
    const { on } = c.req.valid('json')
    await setTaskDreaming(await requireTask(c.req.param('id')), on)
    return ok(c, { on })
  })

export const workspaceDreamRoutes = new Hono().put('/:id/dreaming', validJson(dreamToggle), async (c) => {
  const { on } = c.req.valid('json')
  await setWorkspaceDreaming(c.req.param('id'), on)
  return ok(c, { on })
})

export const dreamRoutes = new Hono()
  .get('/', valid('query', nightQuery), async (c) => ok(c, await nightOf(c.req.valid('query').night)))
  .get('/settings', async (c) => ok(c, await dreamSettings.get()))
  .put('/settings', validJson(dreamSettingsInput), async (c) => ok(c, await updateDreamSettings(c.req.valid('json'))))
  .get('/off', async (c) => {
    const off = await dreamOptOuts.get()
    return ok(c, { tasks: [...off.tasks], workspaces: [...off.workspaces] })
  })
