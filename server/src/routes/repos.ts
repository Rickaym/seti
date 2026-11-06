import { repoInput, warmCacheSettingsInput } from '@seti/shared'
import { Hono } from 'hono'
import { repos } from '../db.js'
import { ok, validJson } from '../http.js'
import { addRepo, removeRepo, requireRepo, setWarmCaches, updateRepo, warmCacheStatus } from '../repo-registry.js'

export const repoRoutes = new Hono()
  .get('/', async (c) => ok(c, await repos.list()))
  .post('/', validJson(repoInput), async (c) => ok(c, await addRepo(c.req.valid('json'))))
  .put('/:id', validJson(repoInput), async (c) => ok(c, await updateRepo(c.req.param('id'), c.req.valid('json'))))
  .get('/:id/warm-caches', async (c) => ok(c, await warmCacheStatus(await requireRepo(c.req.param('id')))))
  .put('/:id/warm-caches', validJson(warmCacheSettingsInput), async (c) =>
    ok(c, await setWarmCaches(await requireRepo(c.req.param('id')), c.req.valid('json'))),
  )
  .delete('/:id', async (c) => {
    await removeRepo(c.req.param('id'))
    return c.body(null, 204)
  })
