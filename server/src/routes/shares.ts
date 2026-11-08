import {
  createShareInput,
  emptyShareInput,
  shareFileQuery,
  shareLinkPreviewInput,
  sharingInput,
  updateShareInput,
  type ShareScanRefusal,
} from '@seti/shared'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { currentPublicHost, currentRequestSource } from '../access.js'
import type { PublicAccess } from '../config.js'
import { refuseEa } from '../ea-guard.js'
import { fail, ok, valid, validJson } from '../http.js'
import {
  createShare,
  fileShare,
  listShares,
  revokeAllShares,
  revokeShare,
  rotateShare,
  setShareLinkPreview,
  setSharing,
  ShareScanError,
  updateShare,
} from '../shares.js'

/** Publishing data outside Seti is the user's call: the EA, agents and devices are refused. */
const userOnly: MiddlewareHandler = async (c, next) => {
  const via = currentRequestSource()?.via
  if (via === 'ea') {
    return refuseEa(c, 'share files outside Seti')
  }
  if (via !== 'local' && via !== 'session' && via !== 'public') {
    return fail(c, 403, 'Forbidden', 'Only the user shares files outside Seti')
  }
  await next()
  return undefined
}

/** Links point at the public host when Seti has one, so a link made on loopback still works. */
const originOf = (c: Context, access: PublicAccess | null) =>
  currentPublicHost()?.origin ?? access?.origin ?? `http://${c.req.header('host') ?? 'localhost'}`

async function scanRefused<T>(c: Context, work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work()
  } catch (e) {
    if (e instanceof ShareScanError) {
      const body: ShareScanRefusal = e.body
      return c.json(body, 409)
    }
    throw e
  }
}

const reply = (c: Context, result: unknown) => (result instanceof Response ? result : ok(c, result))

/** Shares of one agent's files, under /api/tasks. */
export const taskShareRoutes = (access: PublicAccess | null) =>
  new Hono()
    .use('/:id/shares', userOnly)
    .get('/:id/shares', valid('query', shareFileQuery), async (c) => {
      const query = c.req.valid('query')
      return ok(c, await fileShare(c.req.param('id'), query.root, query.path))
    })
    .post('/:id/shares', validJson(createShareInput), async (c) => {
      const input = c.req.valid('json')
      return reply(c, await scanRefused(c, async () => createShare(c.req.param('id'), input, originOf(c, access))))
    })

/** Every share, the Sharing switch, and what changes a share, under /api/shares. */
export const shareRoutes = (access: PublicAccess | null) =>
  new Hono()
    .use('*', userOnly)
    .get('/', async (c) => ok(c, await listShares()))
    .put('/settings', validJson(sharingInput), async (c) => {
      await setSharing(c.req.valid('json').enabled)
      return ok(c, await listShares())
    })
    .post('/revoke-all', validJson(emptyShareInput), async (c) => ok(c, { revoked: await revokeAllShares() }))
    .post('/:id/update', validJson(updateShareInput), async (c) => {
      const input = c.req.valid('json')
      return reply(
        c,
        await scanRefused(c, async () => updateShare(c.req.param('id'), input.allow_findings, input.diagrams)),
      )
    })
    .post('/:id/rotate', validJson(emptyShareInput), async (c) =>
      ok(c, await rotateShare(c.req.param('id'), originOf(c, access))),
    )
    .put('/:id/link-preview', validJson(shareLinkPreviewInput), async (c) =>
      ok(c, await setShareLinkPreview(c.req.param('id'), c.req.valid('json').link_preview)),
    )
    .delete('/:id', async (c) => ok(c, await revokeShare(c.req.param('id'))))
