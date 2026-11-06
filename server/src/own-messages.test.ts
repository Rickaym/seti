import type { MessageBody, OwnMessageStep, RewindRestore, RewindState } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { messages, now, sql, tasks } from './db.js'
import { ownMessages } from './store/own-messages.js'
import { rewinds } from './store/rewinds.js'
import { assistant } from './subtask-fixtures.js'
import { USER_AUTH } from './test-auth.js'

const TASK = 'own-steps'
const app = createApp()

const get = async (path: string) => app.request(`/api${path}`, { headers: { host: 'localhost', ...USER_AUTH } })

const newTask = async (id: string) => {
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
}

const insert = async (body: MessageBody, taskId = TASK) => (await messages.insert(taskId, body, [])).id
const prompt = async (text: string, extra: Record<string, unknown> = {}, taskId = TASK) =>
  insert({ kind: 'prompt', payload: { text, ...extra } }, taskId)
const replies = async (count: number, taskId = TASK) => {
  let last = 0
  for (let i = 0; i < count; i++) {
    last = await insert(assistant([{ type: 'text', text: `step ${String(i)}` }]), taskId)
  }
  return last
}

const fold = async (first: number, last: number, restore: RewindRestore, state: RewindState) => {
  await rewinds.insert({
    task_id: TASK,
    prompt_message_id: first,
    last_message_id: last,
    message_count: 1,
    prompt_text: 'folded',
    restore,
    state,
    resume_at: null,
    drops_turn: null,
    files_changed: [],
  })
}

const ids: Record<string, number> = {}

beforeAll(async () => {
  await newTask(TASK)
  await newTask('own-other')
  await prompt('elsewhere', {}, 'own-other')
  ids.first = await prompt('Fix the login bug')
  ids.firstReply = await replies(3)
  ids.auto = await prompt('', { auto: true, inputs: 2 })
  ids.retry = await prompt('Fix the login bug', { retry: true })
  ids.slash = await prompt('/compact')
  ids.removed = await prompt('Never mind', { queued: 'removed' })
  ids.folded = await prompt('Try the other way')
  ids.foldedReply = await replies(2)
  await fold(ids.folded, ids.foldedReply, 'conversation', 'applied')
  ids.codeOnly = await prompt('Restore the files only')
  await fold(ids.codeOnly, ids.codeOnly, 'code', 'applied')
  ids.refused = await prompt('Refused rewind')
  await fold(ids.refused, ids.refused, 'both', 'refused')
  ids.far = await replies(600)
  ids.last = await prompt('Ship it')
  ids.end = await replies(2)
})

describe('own message steps', () => {
  it('counts prompts the user wrote, slash commands and taken-back ones included', async () => {
    expect((await ownMessages.step(TASK, { before: ids.slash ?? 0 })).id).toBe(ids.first)
    expect((await ownMessages.step(TASK, { after: ids.first ?? 0 })).id).toBe(ids.slash)
    expect((await ownMessages.step(TASK, { after: ids.slash ?? 0 })).id).toBe(ids.removed)
  })

  it('skips rows a conversation rewind folded, but not code-only or refused rewinds', async () => {
    expect((await ownMessages.step(TASK, { after: ids.removed ?? 0 })).id).toBe(ids.codeOnly)
    expect((await ownMessages.step(TASK, { before: ids.codeOnly ?? 0 })).id).toBe(ids.removed)
    expect((await ownMessages.step(TASK, { after: ids.codeOnly ?? 0 })).id).toBe(ids.refused)
  })

  it('gives the page limit that reaches a near message, and none past one page', async () => {
    const near = await ownMessages.step(TASK, { before: (ids.firstReply ?? 0) + 1 })
    expect(near).toEqual({ id: ids.first, reach: 4 })
    const far = await ownMessages.step(TASK, { before: ids.end ?? 0 })
    expect(far).toEqual({ id: ids.last, reach: 2 })
    expect(await ownMessages.step(TASK, { before: ids.last ?? 0 })).toEqual({ id: ids.refused, reach: null })
    expect(await ownMessages.step(TASK, { after: ids.refused ?? 0 })).toEqual({ id: ids.last, reach: null })
  })

  it('finds none at either end of the transcript', async () => {
    expect(await ownMessages.step(TASK, { before: ids.first ?? 0 })).toEqual({ id: null, reach: null })
    expect(await ownMessages.step(TASK, { after: ids.last ?? 0 })).toEqual({ id: null, reach: null })
  })
})

describe('own message route', () => {
  async function step(query: string): Promise<OwnMessageStep> {
    const res = await get(`/tasks/${TASK}/own-message?${query}`)
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: OwnMessageStep }).data
  }

  it('steps back and forward from a cursor', async () => {
    expect((await step(`before=${String(ids.end)}`)).id).toBe(ids.last)
    expect((await step(`after=${String(ids.first)}`)).id).toBe(ids.slash)
  })

  it('takes exactly one cursor', async () => {
    expect((await get(`/tasks/${TASK}/own-message`)).status).toBe(400)
    expect((await get(`/tasks/${TASK}/own-message?before=9&after=3`)).status).toBe(400)
    expect((await get(`/tasks/${TASK}/own-message?before=0`)).status).toBe(400)
  })

  it('refuses archived and missing agents', async () => {
    await newTask('own-archived')
    await sql`UPDATE task SET archived_at = ${now()} WHERE id = 'own-archived'`
    expect((await get('/tasks/own-archived/own-message?before=5')).status).toBe(409)
    expect((await get('/tasks/own-missing/own-message?before=5')).status).toBe(404)
  })
})
