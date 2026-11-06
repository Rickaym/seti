import { prByUrlQuery, prListQuery, prLookupInput, prRefParams } from '@seti/shared'
import { Hono } from 'hono'
import { ok, valid } from '../http.js'
import { requestPreview } from '../pr-preview.js'
import { findPr, listPrs, lookupPrs } from '../prs.js'

export const prRoutes = new Hono()
  .get('/', valid('query', prListQuery), async (c) => ok(c, await listPrs(c.req.valid('query').scope)))
  .get('/by-url', valid('query', prByUrlQuery), async (c) => ok(c, await findPr(c.req.valid('query').url)))
  .post('/lookup', valid('json', prLookupInput), async (c) => ok(c, await lookupPrs(c.req.valid('json').urls)))
  .post('/:owner/:repo/:number/redeploy', valid('param', prRefParams), async (c) => {
    const { owner, repo, number } = c.req.valid('param')
    return ok(c, await requestPreview(owner, repo, number))
  })
