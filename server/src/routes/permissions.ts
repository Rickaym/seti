import {
  addPermissionRuleInput,
  addPermissionRulesInput,
  answerPermissionInput,
  permissionRequestParams,
  permissionRuleParams,
  reviewCoverageQuery,
  setBypassInput,
  taskPermissionRuleParams,
} from '@seti/shared'
import { Hono } from 'hono'
import { setBypass } from '../bypass.js'
import { eaReadOnly } from '../ea-guard.js'
import { ok, valid, validJson } from '../http.js'
import {
  addPermissionRule,
  addPermissionRules,
  agentPermissions,
  answerPermission,
  pendingRequests,
  permissionPolicy,
  removePermissionRule,
  ruleCoverage,
  taskFor,
  taskRequests,
} from '../permission-rules.js'

/** The EA may list rules and requests to remind the user, never change or answer them. */
const userOnly = eaReadOnly('change permission rules or answer permission requests')

const bypassUserOnly = eaReadOnly("turn an agent's Bypass on or off")

export const permissionRoutes = new Hono()
  .use('*', userOnly)
  .get('/', async (c) => ok(c, await permissionPolicy()))
  .post('/rules', validJson(addPermissionRuleInput), async (c) =>
    ok(c, await addPermissionRule(null, c.req.valid('json'))),
  )
  .post('/rules/batch', validJson(addPermissionRulesInput), async (c) =>
    ok(c, await addPermissionRules(null, c.req.valid('json'))),
  )
  .get('/rules/coverage', valid('query', reviewCoverageQuery), async (c) =>
    ok(c, await ruleCoverage(null, c.req.valid('query').rule)),
  )
  .delete('/rules/:rule_id', valid('param', permissionRuleParams), async (c) => {
    await removePermissionRule(null, c.req.valid('param').rule_id)
    return c.body(null, 204)
  })
  .get('/requests', async (c) => ok(c, await pendingRequests()))

export const taskPermissionRoutes = new Hono()
  .get('/:id/permissions', async (c) => ok(c, await agentPermissions(await taskFor(c.req.param('id')))))
  .post('/:id/permissions/rules', userOnly, validJson(addPermissionRuleInput), async (c) =>
    ok(c, await addPermissionRule(await taskFor(c.req.param('id')), c.req.valid('json'))),
  )
  .post('/:id/permissions/rules/batch', userOnly, validJson(addPermissionRulesInput), async (c) =>
    ok(c, await addPermissionRules(await taskFor(c.req.param('id')), c.req.valid('json'))),
  )
  .get('/:id/permissions/rules/coverage', valid('query', reviewCoverageQuery), async (c) =>
    ok(c, await ruleCoverage(await taskFor(c.req.param('id')), c.req.valid('query').rule)),
  )
  .delete('/:id/permissions/rules/:rule_id', userOnly, valid('param', taskPermissionRuleParams), async (c) => {
    const { id, rule_id } = c.req.valid('param')
    await removePermissionRule(await taskFor(id), rule_id)
    return c.body(null, 204)
  })
  .put('/:id/permissions/bypass', bypassUserOnly, validJson(setBypassInput), async (c) =>
    ok(c, await setBypass(await taskFor(c.req.param('id')), c.req.valid('json').hours)),
  )
  .get('/:id/permission-requests', async (c) => ok(c, await taskRequests((await taskFor(c.req.param('id'))).id)))
  .post(
    '/:id/permission-requests/:request_id',
    userOnly,
    valid('param', permissionRequestParams),
    validJson(answerPermissionInput),
    async (c) => {
      const { id, request_id } = c.req.valid('param')
      return ok(c, await answerPermission(await taskFor(id), request_id, c.req.valid('json')))
    },
  )
