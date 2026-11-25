import { dreamDecision, dreamNowInput, dreamSettingsInput, dreamToggle } from '@seti/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { undoTidy } from '../dreams/config-undo.js'
import { dreamNight } from '../dreams/nights.js'
import { decideProposal } from '../dreams/proposals.js'
import { setTaskDreaming, setWorkspaceDreaming, updateDreamSettings } from '../dreams/settings.js'
import { startDream } from '../dreams/start.js'
import { emptyTrash, restoreFromTrash } from '../dreams/trash.js'
import { refuseOnSelf } from '../ea-guard.js'
import { ok, valid, validJson } from '../http.js'
import { dreamOptOuts, dreamSettings } from '../store/dream-nights.js'
import { dreamProposals, trashItems } from '../store/dream-proposals.js'
import { dreamTidies } from '../store/dream-tidies.js'
import { dreamRuns } from '../store/dreams.js'
import { requireTask } from '../tasks.js'

const LISTED = 14

const nightQuery = z.strictObject({ night: z.iso.date().optional() })
const proposalQuery = z.strictObject({ task: z.string().min(1).max(64).optional() })
const idParam = z.strictObject({ id: z.coerce.number().int().positive() })
const tidyQuery = z.strictObject({ task: z.string().min(1).max(64) })

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
  .get('/', valid('query', nightQuery), async (c) => ok(c, await dreamNight(c.req.valid('query').night)))
  .get('/settings', async (c) => ok(c, await dreamSettings.get()))
  .put('/settings', validJson(dreamSettingsInput), async (c) => ok(c, await updateDreamSettings(c.req.valid('json'))))
  .get('/proposals', valid('query', proposalQuery), async (c) =>
    ok(c, await dreamProposals.pending(c.req.valid('query').task)),
  )
  .post('/proposals/:id', valid('param', idParam), validJson(dreamDecision), async (c) =>
    ok(c, await decideProposal(c.req.valid('param').id, c.req.valid('json'))),
  )
  .get('/tidies', valid('query', tidyQuery), async (c) =>
    ok(c, await dreamTidies.forTask((await requireTask(c.req.valid('query').task)).id, LISTED)),
  )
  .post('/tidies/:id/undo', valid('param', idParam), async (c) => ok(c, await undoTidy(c.req.valid('param').id)))
  .get('/off', async (c) => {
    const off = await dreamOptOuts.get()
    return ok(c, { tasks: [...off.tasks], workspaces: [...off.workspaces] })
  })

export const trashRoutes = new Hono()
  .get('/', async (c) => ok(c, await trashItems.list()))
  .post('/:id/restore', valid('param', idParam), async (c) => ok(c, await restoreFromTrash(c.req.valid('param').id)))
  .delete('/', async (c) => ok(c, await emptyTrash()))
