import { compactRuleInput, taskCompactInput } from '@seti/shared'
import { Hono } from 'hono'
import { compactSettingsView, setTaskCompact, taskCompact, updateCompactSettings } from '../compact.js'
import { ok, validJson } from '../http.js'
import { refuseUndeclared } from '../runtime-features.js'
import { takesCompaction } from '../runtimes/capabilities.js'
import { requireTask } from '../tasks.js'

/** The compaction rule every agent starts with unless its own settings give it another. */
export const compactRoutes = new Hono()
  .get('/', async (c) => ok(c, await compactSettingsView()))
  .put('/', validJson(compactRuleInput), async (c) => ok(c, await updateCompactSettings(c.req.valid('json'))))

/** One agent's compaction rule, its own or the default. */
export const taskCompactRoutes = new Hono()
  .get('/:id/compact', async (c) => ok(c, await taskCompact((await requireTask(c.req.param('id'))).id)))
  .put('/:id/compact', validJson(taskCompactInput), async (c) => {
    const task = await requireTask(c.req.param('id'))
    refuseUndeclared(task, takesCompaction(task.runtime), 'compaction rule')
    return ok(c, await setTaskCompact(task, c.req.valid('json').rule))
  })
