import {
  sshAcceptInput,
  sshHostFields,
  sshHostInput,
  sshHostParams,
  sshHostRenameInput,
  sshKeyCreateInput,
  sshKeyFileInput,
  sshKeyImportInput,
  sshKeyParams,
  sshKeyUpdateInput,
  sshKnownHostQuery,
} from '@seti/shared'
import { Hono } from 'hono'
import { audit } from '../audit.js'
import { eaSshReadOnly, fromEa } from '../ea-guard.js'
import { HttpError, ok, valid, validJson } from '../http.js'
import { sshKeyService } from '../ssh-key-service.js'
import { acceptHostKeys, checkHost } from '../ssh-scan.js'
import { createSshHost, deleteSshHost, renameSshHost, sshStatus, updateSshHost } from '../ssh.js'
import { sshKnownHosts } from '../store/ssh.js'

/** SSH hosts with their users and keys, the keys and trusted host keys; no private key leaves. */
export const sshRoutes = new Hono()
  .use('*', eaSshReadOnly)
  .get('/', async (c) => {
    const status = await sshStatus()
    // The EA sees which key each host uses by name, never a key itself.
    return ok(c, fromEa() ? { ...status, keys: [] } : status)
  })
  .post('/hosts', validJson(sshHostInput), async (c) => {
    const { alias, ...fields } = c.req.valid('json')
    return ok(c, await createSshHost(alias, fields))
  })
  .put('/hosts/:alias', valid('param', sshHostParams), validJson(sshHostFields), async (c) =>
    ok(c, await updateSshHost(c.req.valid('param').alias, c.req.valid('json'))),
  )
  .post('/hosts/:alias/rename', valid('param', sshHostParams), validJson(sshHostRenameInput), async (c) =>
    ok(c, await renameSshHost(c.req.valid('param').alias, c.req.valid('json').alias)),
  )
  .delete('/hosts/:alias', valid('param', sshHostParams), async (c) =>
    ok(c, await deleteSshHost(c.req.valid('param').alias)),
  )
  .post('/keys', validJson(sshKeyCreateInput), async (c) => {
    const input = c.req.valid('json')
    return ok(c, await sshKeyService.generate(input.name, input.comment))
  })
  .post('/keys/import', validJson(sshKeyImportInput), async (c) => {
    const input = c.req.valid('json')
    return ok(c, await sshKeyService.import(input.name, input.private_key, input.comment))
  })
  .post('/keys/file', validJson(sshKeyFileInput), async (c) => {
    const input = c.req.valid('json')
    return ok(c, await sshKeyService.file(input.name, input.path))
  })
  .patch('/keys/:id', valid('param', sshKeyParams), validJson(sshKeyUpdateInput), async (c) =>
    ok(c, await sshKeyService.update(c.req.valid('param').id, c.req.valid('json'))),
  )
  .delete('/keys/:id', valid('param', sshKeyParams), async (c) => {
    const key = await sshKeyService.remove(c.req.valid('param').id)
    if (key === null) {
      throw new HttpError(404, 'No such ssh key')
    }
    return ok(c, { id: key.id })
  })
  .post('/hosts/:alias/check', valid('param', sshHostParams), async (c) =>
    ok(c, await checkHost(c.req.valid('param').alias)),
  )
  .post('/known-hosts', validJson(sshAcceptInput), async (c) => {
    const accepted = await acceptHostKeys(c.req.valid('json').lines)
    await audit.record({
      actor: 'user',
      kind: 'system.ssh_host_keys_accepted',
      subject_type: 'system',
      summary: `Trusted ${[...new Set(accepted.map((entry) => entry.host))].join(', ')} for sandboxed ssh`,
      detail: { keys: accepted.map((entry) => `${entry.host} ${entry.key_type} ${entry.fingerprint}`) },
    })
    return ok(c, await sshStatus())
  })
  .delete('/known-hosts', valid('query', sshKnownHostQuery), async (c) => {
    const { host } = c.req.valid('query')
    if ((await sshKnownHosts.deleteHost(host)) > 0) {
      await audit.record({
        actor: 'user',
        kind: 'system.ssh_host_removed',
        subject_type: 'system',
        summary: `Stopped trusting ${host} for sandboxed ssh`,
        detail: { host },
      })
    }
    return ok(c, await sshStatus())
  })
