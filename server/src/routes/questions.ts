import { answerQuestionsInput, questionListQuery } from '@seti/shared'
import { Hono } from 'hono'
import { ok, valid, validJson } from '../http.js'
import { answerQuestions } from '../question-answers.js'
import { questions } from '../store/questions.js'

/** Questions agents ask the user, under /api/questions; the user and the EA answer them. */
export const questionRoutes = new Hono()
  .get('/', valid('query', questionListQuery), async (c) => {
    const { task_id, all } = c.req.valid('query')
    return ok(
      c,
      task_id !== undefined && all === 'true' ? await questions.forTask(task_id) : await questions.openList(task_id),
    )
  })
  .post('/answers', validJson(answerQuestionsInput), async (c) => ok(c, await answerQuestions(c.req.valid('json'))))
