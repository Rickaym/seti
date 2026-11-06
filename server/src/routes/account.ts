import { accountRefreshInput, loginNameInput, loginParams, signInCodeInput } from '@seti/shared'
import { Hono } from 'hono'
import { accountStatus, loginsChanged } from '../account.js'
import { removeLogin, renameLogin, saveCurrentLogin, switchLogin, userOnly } from '../claude-logins.js'
import { signIns } from '../claude-sign-in.js'
import { eaReadOnly } from '../ea-guard.js'
import { HttpError, ok, valid, validJson } from '../http.js'
import { loginRows } from '../store/claude-logins.js'

const guard = eaReadOnly('add, rename, remove or switch Claude logins')

/** Saved Claude logins: only the user adds, renames, removes and switches them. */
const loginRoutes = new Hono()
  .use('*', guard)
  .post('/', validJson(loginNameInput), async (c) => {
    const login = await saveCurrentLogin(c.req.valid('json').name)
    loginsChanged()
    return ok(c, login)
  })
  .patch('/:id', valid('param', loginParams), validJson(loginNameInput), async (c) =>
    ok(c, await renameLogin(c.req.valid('param').id, c.req.valid('json').name)),
  )
  .delete('/:id', valid('param', loginParams), async (c) => {
    await removeLogin(c.req.valid('param').id)
    return ok(c, { removed: true })
  })
  .post('/:id/switch', valid('param', loginParams), async (c) => {
    const result = await switchLogin(c.req.valid('param').id)
    loginsChanged()
    return ok(c, result)
  })

/** Signing in to another Claude account from Seti, without touching the login in use. */
const signInRoutes = new Hono()
  .use('*', guard)
  .post('/', validJson(loginNameInput), async (c) => {
    userOnly('add Claude logins')
    const { name } = c.req.valid('json')
    const taken = await loginRows.byName(name)
    if (taken !== undefined) {
      throw new HttpError(409, `A login named ${taken.name} already exists`)
    }
    return ok(c, await signIns.start(name))
  })
  .post('/:id', valid('param', loginParams), validJson(signInCodeInput), async (c) => {
    userOnly('add Claude logins')
    const result = await signIns.finish(c.req.valid('param').id, c.req.valid('json').code)
    loginsChanged()
    return ok(c, result)
  })
  .delete('/:id', valid('param', loginParams), (c) => {
    signIns.cancel(c.req.valid('param').id)
    return ok(c, { cancelled: true })
  })

export const accountRoutes = new Hono()
  .get('/', async (c) => ok(c, await accountStatus({ refresh: false })))
  .post('/refresh', validJson(accountRefreshInput), async (c) => ok(c, await accountStatus({ refresh: true })))
  .route('/logins', loginRoutes)
  .route('/sign-in', signInRoutes)
