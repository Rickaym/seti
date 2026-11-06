import {
  contextPackDefaultInput,
  contextPackInput,
  newContextPackInput,
  taskContextPacksInput,
  taskRoleInput,
  writeContextFileInput,
} from '@seti/shared'
import { Hono } from 'hono'
import {
  createPack,
  deletePack,
  duplicatePack,
  requirePack,
  saveContextFile,
  setEaPacks,
  setEaRole,
  setPackLinkedByDefault,
  setTaskPacks,
  setTaskRole,
  updatePack,
} from '../context-changes.js'
import { listContextFiles, readContextFile } from '../context-files.js'
import { ok, validJson } from '../http.js'
import { eaPackPrompt, packForDisplay } from '../seti-guide.js'
import { contextPacks, eaContextPacks, packLinks, taskContextPacks } from '../store/context.js'
import { requireTask } from '../tasks.js'

export const contextRoutes = new Hono()
  .get('/files', async (c) => ok(c, await listContextFiles()))
  .get('/files/:key', async (c) => ok(c, await readContextFile(c.req.param('key'))))
  .put('/files/:key', validJson(writeContextFileInput), async (c) => {
    const input = c.req.valid('json')
    return ok(c, (await saveContextFile(c.req.param('key'), input.content, input.base_hash)).value)
  })
  .get('/packs', async (c) => ok(c, (await contextPacks.list()).map(packForDisplay)))
  .post('/packs', validJson(newContextPackInput), async (c) => {
    const { kind, ...fields } = c.req.valid('json')
    return ok(c, (await createPack(fields, kind)).value)
  })
  .post('/packs/:id/duplicate', async (c) => ok(c, (await duplicatePack(c.req.param('id'))).value))
  .get('/packs/:id', async (c) => ok(c, packForDisplay(await requirePack(c.req.param('id')))))
  .get('/packs/:id/links', async (c) => ok(c, await packLinks(await requirePack(c.req.param('id')))))
  .put('/packs/:id', validJson(contextPackInput), async (c) =>
    ok(c, (await updatePack(c.req.param('id'), c.req.valid('json'))).value),
  )
  .put('/packs/:id/default', validJson(contextPackDefaultInput), async (c) =>
    ok(c, packForDisplay(await setPackLinkedByDefault(c.req.param('id'), c.req.valid('json').linked_by_default))),
  )
  .delete('/packs/:id', async (c) => {
    await deletePack(c.req.param('id'))
    return c.body(null, 204)
  })

/** Mounted beside taskRoutes under /api/tasks. */
export const taskContextRoutes = new Hono()
  .get('/:id/context-packs', async (c) => ok(c, await taskContextPacks.list((await requireTask(c.req.param('id'))).id)))
  .put('/:id/context-packs', validJson(taskContextPacksInput), async (c) =>
    ok(c, await setTaskPacks(await requireTask(c.req.param('id')), c.req.valid('json').pack_ids)),
  )
  .put('/:id/role', validJson(taskRoleInput), async (c) =>
    ok(c, await setTaskRole(await requireTask(c.req.param('id')), c.req.valid('json').pack_id)),
  )

/** Mounted under /api/ea: the packs linked to the EA and the text they add to its prompt. */
export const eaContextPackRoutes = new Hono()
  .get('/context-packs', async (c) => ok(c, await eaContextPacks.summaries()))
  .put('/context-packs', validJson(taskContextPacksInput), async (c) =>
    ok(c, await setEaPacks(c.req.valid('json').pack_ids)),
  )
  .get('/context-packs/prompt', async (c) => ok(c, await eaPackPrompt()))
  .put('/role', validJson(taskRoleInput), async (c) => ok(c, await setEaRole(c.req.valid('json').pack_id)))
