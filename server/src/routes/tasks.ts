import {
  chatSearchQuery,
  createTaskInput,
  dismissInputsInput,
  messagePageQuery,
  ownMessageQuery,
  rewindFilesQuery,
  restartSessionInput,
  rewindInput,
  sendMessageInput,
  startAgentInput,
  stopTurnQuery,
  subtaskParams,
  taskDigestQuery,
  taskDirInput,
  taskMessageParams,
  taskMessagesQuery,
  taskPrInput,
  taskRepoInput,
  taskRepoParams,
  taskMcpInput,
  taskAccessInput,
  TASK_STREAM_CURSOR,
  taskStreamQuery,
  toMcpChoices,
  updateTaskInput,
  type InputPause,
} from '@seti/shared'
import { Hono } from 'hono'
import { effectiveAccess, setTaskAccess } from '../agent-access.js'
import { createTask, startAgent } from '../agent-start.js'
import { archivedMessage } from '../archive.js'
import { messages, tasks } from '../db.js'
import { hideDirect } from '../direct-privacy.js'
import { eaSecurityAccessRefusal, fromEa, notEa, refuseEa } from '../ea-guard.js'
import { HttpError, ok, valid, validJson } from '../http.js'
import { burstPausedUntil, deliverPending, dismissPending } from '../inputs.js'
import { setTaskMcpChoices, taskMcpServers } from '../mcp-selection.js'
import { previewRewindFiles, rewindTargets, rewindTask } from '../rewind-task.js'
import { openQuerySince } from '../runner.js'
import { scrubValue } from '../scrub.js'
import { restartSession } from '../session-restart.js'
import { ownMessages, type OwnCursor } from '../store/own-messages.js'
import { rewinds } from '../store/rewinds.js'
import { messageSearch } from '../store/search.js'
import { subtaskBriefs, subtaskPage } from '../subtask-cache.js'
import {
  deleteTask,
  endTaskSession,
  linkSubtaskPrUrl,
  requireSubtask,
  retryTask,
  sendTaskMessage,
  stopSubtask,
  stopTask,
  takeBackQueued,
  taskDigest,
  taskListEntries,
  transcriptPage,
  unlinkSubtaskPrUrl,
  updateTask,
} from '../task-actions.js'
import { addTaskDir, addTaskRepo, removeTaskDir, removeTaskRepo } from '../task-location.js'
import { linkTaskPr, requireTask, unlinkTaskPr } from '../tasks.js'
import { wirePage } from '../transcript.js'
import { streamTask } from './stream.js'

/** The stream cursor an EventSource sends back on its own reconnect, when it is one. */
const lastEventId = (header: string | undefined) =>
  header !== undefined && TASK_STREAM_CURSOR.test(header) ? header : undefined

const taskIdOf = async (id: string) => (await requireTask(id)).id

/** The task when its transcript is in the table; an archived one is searched after a restore. */
async function liveTranscript(id: string) {
  const task = await requireTask(id)
  if (task.archived_at !== null) {
    throw new HttpError(409, 'Restore the agent to search or jump within its transcript')
  }
  return task
}

const ownCursor = ({ before, after }: { before?: number | undefined; after?: number | undefined }): OwnCursor =>
  before === undefined ? { after: after ?? 0 } : { before }

interface PageRequest {
  before?: number | undefined
  after?: number | undefined
  around?: number | undefined
  limit: number
}

async function messagesPage(id: string, { before, after, around, limit }: PageRequest) {
  if (around === undefined && after === undefined) {
    return transcriptPage(id, limit, before)
  }
  const task = await liveTranscript(id)
  const page =
    around === undefined
      ? await messages.pageAfter(task.id, limit, after ?? 0)
      : await messages.around(task.id, limit, around)
  return { ...page, messages: await hideDirect(task.id, page.messages) }
}

export const taskRoutes = new Hono()
  .get('/', async (c) => ok(c, await taskListEntries()))
  .post('/', validJson(createTaskInput), async (c) => {
    const input = c.req.valid('json')
    if (fromEa() && !input.sandbox) {
      return refuseEa(c, 'start an agent outside the sandbox')
    }
    if (fromEa() && input.seti_control === 'full') {
      return refuseEa(c, 'give an agent Seti control')
    }
    const refusal = eaSecurityAccessRefusal(
      c,
      input.access.map((choice) => choice.kind),
    )
    return refusal ?? ok(c, await createTask(input))
  })
  .post('/start', validJson(startAgentInput), async (c) => ok(c, await startAgent(c.req.valid('json'))))
  .get('/:id', async (c) => ok(c, await requireTask(c.req.param('id'))))
  .patch('/:id', validJson(updateTaskInput), async (c) => {
    const input = c.req.valid('json')
    if (fromEa() && input.sandbox !== undefined) {
      return refuseEa(c, "change an agent's sandbox")
    }
    if (fromEa() && input.seti_control !== undefined) {
      return refuseEa(c, "change an agent's Seti control")
    }
    return ok(c, await updateTask(await taskIdOf(c.req.param('id')), input))
  })
  .get('/:id/access', async (c) => ok(c, await effectiveAccess(await requireTask(c.req.param('id')))))
  .put('/:id/access', validJson(taskAccessInput), async (c) => {
    const change = c.req.valid('json')
    const refusal = eaSecurityAccessRefusal(c, [change.kind])
    return refusal ?? ok(c, await setTaskAccess(await requireTask(c.req.param('id')), change))
  })
  .get('/:id/mcp', async (c) => ok(c, await taskMcpServers(await taskIdOf(c.req.param('id')))))
  .put('/:id/mcp', validJson(taskMcpInput), async (c) => {
    const task = await requireTask(c.req.param('id'))
    await setTaskMcpChoices(task, toMcpChoices(c.req.valid('json')))
    return ok(c, await taskMcpServers(task.id))
  })
  .post('/:id/repos', validJson(taskRepoInput), async (c) => {
    const task = await requireTask(c.req.param('id'))
    await addTaskRepo(task, c.req.valid('json'))
    return ok(c, await requireTask(task.id))
  })
  .delete('/:id/repos/:repo_id', valid('param', taskRepoParams), async (c) => {
    const { id, repo_id } = c.req.valid('param')
    const task = await requireTask(id)
    await removeTaskRepo(task, repo_id)
    return ok(c, await requireTask(task.id))
  })
  .post('/:id/dirs', validJson(taskDirInput), async (c) => {
    const task = await requireTask(c.req.param('id'))
    await addTaskDir(task, c.req.valid('json').path)
    return ok(c, await requireTask(task.id))
  })
  .delete('/:id/dirs', valid('query', taskDirInput), async (c) => {
    const task = await requireTask(c.req.param('id'))
    await removeTaskDir(task, c.req.valid('query').path)
    return ok(c, await requireTask(task.id))
  })
  .post('/:id/prs', validJson(taskPrInput), async (c) => {
    const id = await taskIdOf(c.req.param('id'))
    await linkTaskPr(id, c.req.valid('json').url)
    return ok(c, await requireTask(id))
  })
  .delete('/:id/prs', valid('query', taskPrInput), async (c) => {
    const id = await taskIdOf(c.req.param('id'))
    if (!(await unlinkTaskPr(id, c.req.valid('query').url))) {
      throw new HttpError(404, 'That pull request is not linked to this agent')
    }
    return ok(c, await requireTask(id))
  })
  .get('/:id/messages', valid('query', taskMessagesQuery), async (c) =>
    ok(c, wirePage(await messagesPage(c.req.param('id'), c.req.valid('query')))),
  )
  .get('/:id/own-message', valid('query', ownMessageQuery), async (c) => {
    const task = await liveTranscript(c.req.param('id'))
    return ok(c, await ownMessages.step(task.id, ownCursor(c.req.valid('query'))))
  })
  .get('/:id/search', valid('query', chatSearchQuery), async (c) => {
    const task = await liveTranscript(c.req.param('id'))
    return ok(c, await messageSearch.search(task.id, c.req.valid('query')))
  })
  .get('/:id/digest', valid('query', taskDigestQuery), async (c) =>
    ok(c, await taskDigest(await taskIdOf(c.req.param('id')), c.req.valid('query').limit)),
  )
  .get('/:id/subtasks', async (c) => {
    const id = await taskIdOf(c.req.param('id'))
    return ok(c, await subtaskBriefs(id, openQuerySince(id)))
  })
  .get('/:id/subtasks/:tool_use_id', valid('param', subtaskParams), async (c) => {
    const { id, tool_use_id } = c.req.valid('param')
    return ok(c, await requireSubtask(id, tool_use_id))
  })
  .get(
    '/:id/subtasks/:tool_use_id/messages',
    valid('param', subtaskParams),
    valid('query', messagePageQuery),
    async (c) => {
      const { id, tool_use_id } = c.req.valid('param')
      const { before, limit } = c.req.valid('query')
      const page = await subtaskPage(id, await requireSubtask(id, tool_use_id), limit, before)
      return ok(c, wirePage({ ...page, messages: await hideDirect(await taskIdOf(id), page.messages) }))
    },
  )
  .post('/:id/subtasks/:tool_use_id/stop', valid('param', subtaskParams), async (c) => {
    const { id, tool_use_id } = c.req.valid('param')
    return ok(c, await stopSubtask(id, tool_use_id))
  })
  .post('/:id/subtasks/:tool_use_id/prs', valid('param', subtaskParams), validJson(taskPrInput), async (c) => {
    const { id, tool_use_id } = c.req.valid('param')
    return ok(c, await linkSubtaskPrUrl(await taskIdOf(id), tool_use_id, c.req.valid('json').url))
  })
  .delete('/:id/subtasks/:tool_use_id/prs', valid('param', subtaskParams), valid('query', taskPrInput), async (c) => {
    const { id, tool_use_id } = c.req.valid('param')
    return ok(c, await unlinkSubtaskPrUrl(await taskIdOf(id), tool_use_id, c.req.valid('query').url))
  })
  .get('/:id/messages/:message_id', valid('param', taskMessageParams), async (c) => {
    const { id, message_id } = c.req.valid('param')
    const task = await requireTask(id)
    const row =
      task.archived_at === null ? await messages.get(task.id, message_id) : await archivedMessage(task.id, message_id)
    if (!row) {
      throw new HttpError(404, 'Message not found')
    }
    const [shown] = await hideDirect(task.id, [row])
    return ok(c, scrubValue(shown ?? row))
  })
  .post('/:id/messages', validJson(sendMessageInput), async (c) =>
    ok(c, await sendTaskMessage(await taskIdOf(c.req.param('id')), c.req.valid('json'))),
  )
  .post('/:id/retry', async (c) => ok(c, await retryTask(await taskIdOf(c.req.param('id')))))
  .post('/:id/seen', async (c) => {
    const id = await taskIdOf(c.req.param('id'))
    await tasks.markSeen(id)
    return ok(c, await requireTask(id))
  })
  .delete('/:id/queue/:message_id', valid('param', taskMessageParams), async (c) => {
    const { id, message_id } = c.req.valid('param')
    return ok(c, await takeBackQueued(await requireTask(id), message_id))
  })
  .get('/:id/inputs', async (c) => {
    const id = await taskIdOf(c.req.param('id'))
    return ok(c, { paused_until: (await burstPausedUntil(id))?.toISOString() ?? null } satisfies InputPause)
  })
  .post('/:id/inputs/deliver', async (c) => {
    const id = await taskIdOf(c.req.param('id'))
    await deliverPending(id, 'user')
    return ok(c, await requireTask(id))
  })
  .post('/:id/inputs/dismiss', validJson(dismissInputsInput), async (c) => {
    const id = await taskIdOf(c.req.param('id'))
    return ok(c, await dismissPending(id, c.req.valid('json').up_to, 'user'))
  })
  .post('/:id/stop', valid('query', stopTurnQuery), async (c) => {
    const deliverQueued = c.req.valid('query').queued === 'deliver'
    return ok(c, await stopTask(await taskIdOf(c.req.param('id')), { deliverQueued }))
  })
  .post('/:id/session/end', async (c) => ok(c, await endTaskSession(await taskIdOf(c.req.param('id')))))
  .post('/:id/session/restart', validJson(restartSessionInput), async (c) => {
    const task = await requireTask(c.req.param('id'))
    await restartSession(task, c.req.valid('json'))
    return ok(c, await requireTask(task.id))
  })
  .get('/:id/rewinds', async (c) => ok(c, await rewinds.list(await taskIdOf(c.req.param('id')))))
  .get('/:id/rewind/targets', async (c) => ok(c, await rewindTargets(c.req.param('id'))))
  .get('/:id/rewind/files', valid('query', rewindFilesQuery), async (c) =>
    ok(c, await previewRewindFiles(c.req.param('id'), c.req.valid('query').message_id)),
  )
  .post('/:id/rewind', validJson(rewindInput), async (c) => {
    const { message_id, restore } = c.req.valid('json')
    return ok(c, await rewindTask(c.req.param('id'), message_id, restore))
  })
  .delete('/:id', async (c) => {
    await deleteTask(await requireTask(c.req.param('id')))
    return c.body(null, 204)
  })
  .get(
    '/:id/stream',
    notEa('follow a transcript live; it reads pages instead'),
    valid('query', taskStreamQuery),
    async (c) => {
      const task = await requireTask(c.req.param('id'))
      const { after, tail } = c.req.valid('query')
      const start = { after: after ?? lastEventId(c.req.header('Last-Event-ID')), tail }
      return streamTask(c, task.id, { ...start, archived: task.archived_at !== null })
    },
  )
