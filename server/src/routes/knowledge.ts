import {
  approveKnowledgeInput,
  knowledgeFields,
  knowledgeListQuery,
  knowledgeParams,
  knowledgeSearchQuery,
  rejectKnowledgeInput,
} from '@seti/shared'
import { Hono } from 'hono'
import { notEa } from '../ea-guard.js'
import { HttpError, ok, valid, validJson } from '../http.js'
import { approveKnowledge, editKnowledge, KNOWLEDGE_REVIEW, rejectKnowledge } from '../knowledge-review.js'
import { proposeKnowledge, requestProposer, searchKnowledge } from '../knowledge.js'
import { knowledge } from '../store/knowledge.js'

/** The EA reads and proposes notes; only the user approves, rejects or edits them. */
const userOnly = notEa(KNOWLEDGE_REVIEW)

/** Notes agents propose and the user approves, under /api/knowledge. */
export const knowledgeRoutes = new Hono()
  .get('/', valid('query', knowledgeListQuery), async (c) => ok(c, await knowledge.list(c.req.valid('query').status)))
  .get('/summary', async (c) => ok(c, await knowledge.summary()))
  .get('/search', valid('query', knowledgeSearchQuery), async (c) => {
    const { q, repo_id } = c.req.valid('query')
    return ok(c, await searchKnowledge(q, repo_id === undefined ? null : [repo_id]))
  })
  .post('/', validJson(knowledgeFields), async (c) =>
    ok(c, await proposeKnowledge(requestProposer(), c.req.valid('json'))),
  )
  .get('/:id', valid('param', knowledgeParams), async (c) => {
    const note = await knowledge.get(c.req.valid('param').id)
    if (note === undefined) {
      throw new HttpError(404, 'No knowledge note has that id')
    }
    return ok(c, note)
  })
  .put('/:id', userOnly, valid('param', knowledgeParams), validJson(knowledgeFields), async (c) =>
    ok(c, (await editKnowledge(c.req.valid('param').id, c.req.valid('json'))).note),
  )
  .post('/:id/approve', userOnly, valid('param', knowledgeParams), validJson(approveKnowledgeInput), async (c) =>
    ok(c, await approveKnowledge(c.req.valid('param').id, c.req.valid('json'))),
  )
  .post('/:id/reject', userOnly, valid('param', knowledgeParams), validJson(rejectKnowledgeInput), async (c) =>
    ok(c, await rejectKnowledge(c.req.valid('param').id, c.req.valid('json').reason)),
  )
