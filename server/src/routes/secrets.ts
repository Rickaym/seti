import { isSecretName, secretSetInput, SECRET_INFO, type SecretName } from '@seti/shared'
import { Hono, type Context } from 'hono'
import { audit } from '../audit.js'
import { notEa } from '../ea-guard.js'
import { HttpError, ok, validJson } from '../http.js'
import { secrets } from '../secrets.js'

function nameOf(c: Context): SecretName {
  const name = c.req.param('name') ?? ''
  if (!isSecretName(name)) {
    throw new HttpError(404, 'No such secret')
  }
  return name
}

/** Secrets by name: whether each is set and when. Values go in and never come back out. */
export const secretRoutes = new Hono()
  .use('*', notEa('manage secrets'))
  .get('/', async (c) => ok(c, await secrets.list()))
  .put('/:name', validJson(secretSetInput), async (c) => {
    const name = nameOf(c)
    const status = await secrets.set(name, c.req.valid('json').value, 'settings')
    await audit.record({
      actor: 'user',
      kind: 'system.secret_set',
      subject_type: 'system',
      subject_id: name,
      summary: `Set the ${SECRET_INFO[name].label}`,
      detail: { name },
    })
    return ok(c, status)
  })
  .delete('/:name', async (c) => {
    const name = nameOf(c)
    const { status, removed } = await secrets.clear(name)
    if (removed) {
      await audit.record({
        actor: 'user',
        kind: 'system.secret_cleared',
        subject_type: 'system',
        subject_id: name,
        summary: `Cleared the ${SECRET_INFO[name].label}`,
        detail: { name },
      })
    }
    return ok(c, status)
  })
