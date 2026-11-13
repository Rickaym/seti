import {
  checkMessageBody,
  modelFallbackOf,
  movesSession,
  switchableModel,
  switchBackPrompt,
  type Task,
} from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { messages, sql, tasks } from './db.js'
import { tierOfItem } from './ea-attention.js'
import { endSession, runTurn } from './runner.js'
import { auditEvents } from './store/audit.js'
import { eaInbox } from './store/inbox.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

const EXPLANATION =
  'Cyber safeguards flagged this message. If this is legitimate security work, you can apply for the ' +
  'Cyber Verification Program: https://support.claude.com/en/articles/14604842-cyber-verification-program'

/** The notice Claude Code sends, with a fixed uuid so a test can repeat it as a replay would. */
const FALLBACK = {
  type: 'system',
  subtype: 'model_refusal_fallback',
  trigger: 'refusal',
  direction: 'retry',
  scope: 'session',
  original_model: 'claude-opus-5-5',
  fallback_model: 'claude-opus-4-8',
  request_id: 'req_011CYf',
  api_refusal_category: 'cyber',
  api_refusal_explanation: EXPLANATION,
  api_refusal_cyber_verification: { type: 'inactive' },
  retracted_message_uuids: [],
  refused_user_message_uuid: null,
  content: "Opus 5.5's safeguards flagged this session.",
  session_id: 'fake-session',
  uuid: '11111111-2222-4333-8444-555555555555',
}

/** The notice the next `refuse` or `replay` turn streams. */
const streamed: { event: typeof FALLBACK } = { event: FALLBACK }

/** `refuse` falls back, `replay` repeats that notice, `init <model>` and `/model` start turns. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeMessage, fakeResult } = await import('./fake-sdk.js')
  const init = (model: string) =>
    fakeMessage('system', { subtype: 'init', model, permissionMode: 'default', cwd: '/tmp', tools: [] })
  const fake = new FakeSdk(function* (played) {
    const [word, arg] = played.text.split(' ')
    if (word === 'refuse' || word === 'replay') {
      if (word === 'refuse') {
        yield init('claude-opus-5-5')
      }
      yield streamed.event
    } else if (word === 'init' || word === '/model') {
      yield init(word === 'init' ? (arg ?? '') : 'claude-opus-4-8')
    }
    yield fakeResult()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
const created: string[] = []

async function newTask(): Promise<Task> {
  const id = `fallback-task-${String(created.length + 1)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  created.push(id)
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('no task')
  }
  return task
}

async function turn(taskId: string, text: string): Promise<Task | undefined> {
  await runTurn(taskId, text)
  await waitIdle(taskId)
  await auditEvents.settled()
  return tasks.get(taskId)
}

const audited = async (taskId: string) =>
  (
    await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_event
      WHERE kind = 'task.model_fallback' AND subject_id = ${taskId}`
  )[0]?.n

const switchBack = async (taskId: string, auth: object = USER_AUTH) =>
  app.request(`/api/tasks/${taskId}/model/switch-back`, {
    method: 'POST',
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
  })

afterAll(async () => {
  for (const id of created) {
    await endSession(id)
  }
})

describe('model fallback', () => {
  it('reads the notice in the shape the Agent SDK types it, and stores it', () => {
    const event = modelFallbackOf(FALLBACK)
    expect(event).toMatchObject({ original_model: 'claude-opus-5-5', api_refusal_category: 'cyber' })
    expect(event === null ? null : movesSession(event)).toBe(true)
    expect(movesSession({ scope: 'local' })).toBe(false)
    expect(movesSession({})).toBe(true)
    expect(modelFallbackOf({ ...FALLBACK, subtype: 'init' })).toBeNull()
    expect(checkMessageBody('sdk', FALLBACK).ok).toBe(true)
    expect(checkMessageBody('sdk', { ...FALLBACK, original_model: 5 }).ok).toBe(false)
  })

  it('switches back with /model and the original id, and never with other words', () => {
    expect(switchBackPrompt('claude-opus-5-5')).toBe('/model claude-opus-5-5')
    expect(switchableModel('claude-opus-4-6[1m]')).toBe(true)
    expect(switchableModel('opus\n/clear')).toBe(false)
    expect(() => switchBackPrompt('opus and then')).toThrow()
  })

  it('audits a fallback once, even when the stream repeats it, and tells the EA at the active tier', async () => {
    const task = await newTask()
    await turn(task.id, 'refuse')
    await turn(task.id, 'replay')
    expect(await audited(task.id)).toBe(1)
    expect(await auditEvents.latest('task.model_fallback')).toMatchObject({
      actor: 'system',
      subject_id: task.id,
      summary: `Claude Code switched task "${task.title}" from Opus 5.5 to Opus 4.8 after a cyber safeguard flagged a request`,
      detail: {
        original_model: 'claude-opus-5-5',
        fallback_model: 'claude-opus-4-8',
        category: 'cyber',
        request_id: 'req_011CYf',
      },
    })
    expect(JSON.stringify((await auditEvents.latest('task.model_fallback'))?.detail)).not.toContain('Verification')
    const rows = (await messages.page(task.id, 50)).messages.filter((row) => modelFallbackOf(row.payload) !== null)
    expect(rows).toHaveLength(1)
    const items = (await eaInbox.due(new Date().toISOString(), 50, ['watch_event'])).filter(
      (item) => item.task_id === task.id && item.event === 'model_fallback',
    )
    expect(items.map((item) => [item.title, item.severity, tierOfItem(item)])).toEqual([
      [`${task.title} switched from Opus 5.5 to Opus 4.8`, 'warning', 'active'],
    ])
  })

  it('marks the task while a session start reports the fallback, and clears it on another model', async () => {
    const task = await newTask()
    expect((await turn(task.id, 'refuse'))?.model_fallback).toMatchObject({
      original_model: 'claude-opus-5-5',
      fallback_model: 'claude-opus-4-8',
      category: 'cyber',
    })
    expect((await turn(task.id, 'init claude-opus-4-8'))?.model_fallback).not.toBeNull()
    expect((await turn(task.id, 'init claude-opus-5-5'))?.model_fallback).toBeNull()
  })

  it('leaves the session model alone when only a subagent fell back', async () => {
    const task = await newTask()
    streamed.event = { ...FALLBACK, scope: 'local', uuid: '11111111-2222-4333-8444-666666666666' }
    try {
      expect((await turn(task.id, 'replay'))?.model_fallback).toBeNull()
    } finally {
      streamed.event = FALLBACK
    }
    expect(await audited(task.id)).toBe(1)
  })

  it('sends /model with the original model as a message, for the user and the EA alike', async () => {
    const task = await newTask()
    expect((await switchBack(task.id)).status).toBe(409)
    await turn(task.id, 'refuse')
    const res = await switchBack(task.id, EA_AUTH)
    expect(res.status).toBe(200)
    await waitIdle(task.id)
    await auditEvents.settled()
    expect(sdk.fake.prompts.at(-1)).toBe('/model claude-opus-5-5')
    expect(await auditEvents.latest('task.message_sent')).toMatchObject({
      subject_id: task.id,
      detail: { prompt: '/model claude-opus-5-5', switch_back: true },
    })
  })
})
