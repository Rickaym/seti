import {
  githubOwnerName,
  profileAwsInput,
  profileInput,
  profileParams,
  secretSetInput,
  sshSetHostParams,
} from '@seti/shared'
import { Hono, type Context } from 'hono'
import {
  createProfile,
  credentialsOverview,
  deleteProfile,
  profileSummaries,
  renameProfile,
  setProfileAws,
  setProfileGitHub,
  setProfileSshHost,
} from '../credential-profiles.js'
import { notEa } from '../ea-guard.js'
import { HttpError, ok, valid, validJson } from '../http.js'

function ownerOf(c: Context): string {
  const parsed = githubOwnerName.safeParse(c.req.param('owner') ?? '')
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid owner')
  }
  return parsed.data
}

const validId = valid('param', profileParams)

/** Credentials with their tokens' state and connections; values go in and never come out. */
export const credentialRoutes = new Hono()
  .use('*', notEa('see or change credentials or their tokens'))
  .get('/', async (c) => ok(c, await credentialsOverview()))
  .post('/profiles', validJson(profileInput), async (c) => ok(c, await createProfile(c.req.valid('json').name)))
  .patch('/profiles/:id', validId, validJson(profileInput), async (c) =>
    ok(c, await renameProfile(c.req.valid('param').id, c.req.valid('json').name)),
  )
  .delete('/profiles/:id', validId, async (c) => {
    await deleteProfile(c.req.valid('param').id)
    return c.body(null, 204)
  })
  .put('/profiles/:id/aws', validId, validJson(profileAwsInput), async (c) =>
    ok(c, await setProfileAws(c.req.valid('param').id, c.req.valid('json'))),
  )
  .put('/profiles/:id/github', validId, validJson(secretSetInput), async (c) =>
    ok(c, await setProfileGitHub(c.req.valid('param').id, null, c.req.valid('json').value)),
  )
  .delete('/profiles/:id/github', validId, async (c) =>
    ok(c, await setProfileGitHub(c.req.valid('param').id, null, null)),
  )
  .put('/profiles/:id/github/:owner', validJson(secretSetInput), async (c) =>
    ok(c, await setProfileGitHub(c.req.param('id'), ownerOf(c), c.req.valid('json').value)),
  )
  .delete('/profiles/:id/github/:owner', async (c) =>
    ok(c, await setProfileGitHub(c.req.param('id'), ownerOf(c), null)),
  )
  .put('/profiles/:id/ssh-hosts/:alias', valid('param', sshSetHostParams), async (c) => {
    const { id, alias } = c.req.valid('param')
    return ok(c, await setProfileSshHost(id, alias, true))
  })
  .delete('/profiles/:id/ssh-hosts/:alias', valid('param', sshSetHostParams), async (c) => {
    const { id, alias } = c.req.valid('param')
    return ok(c, await setProfileSshHost(id, alias, false))
  })

/** Profile names and how many agents use each, which the EA may read to assign one. */
export const profileSummaryRoutes = new Hono().get('/', async (c) => ok(c, await profileSummaries()))
