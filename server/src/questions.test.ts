import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AnswerQuestionsResult, Question, Task } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { tasks } from './db.js'
import { answerQuestions, SECRET_ANSWER } from './question-answers.js'
import { expireLeftoverQuestions, questionsContext } from './questions.js'
import { endSession, runTurn, stopTurn } from './runner.js'
import { auditEvents } from './store/audit.js'
import { questions } from './store/questions.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

const PUSH = 'Should I push the fix to main?'
const CHECKS = 'Which checks should I run first?'

/** Calls AskUserQuestion as Claude Code does and writes what it got back as the reply. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('./fake-sdk.js')
  const input = {
    questions: [
      {
        question: 'Should I push the fix to main?',
        header: 'Push',
        multiSelect: false,
        options: [
          { label: 'Yes', description: 'Push it now' },
          { label: 'No', description: 'Keep it local' },
        ],
      },
      {
        question: 'Which checks should I run first?',
        header: 'Checks',
        multiSelect: true,
        options: [
          { label: 'Unit', description: 'pnpm test' },
          { label: 'Lint', description: 'pnpm lint' },
          { label: 'E2E', description: 'pnpm e2e' },
        ],
      },
    ],
  }
  const ask = async (canUseTool: CanUseTool, signal: AbortSignal): Promise<PermissionResult | null> =>
    canUseTool('AskUserQuestion', input, { signal, toolUseID: 'toolu_ask', requestId: 'req_ask' })
  const fake = new FakeSdk(async function* (turn) {
    const { canUseTool } = turn.session.options
    const result = canUseTool === undefined ? null : await ask(canUseTool, turn.signal)
    yield fakeAssistant(JSON.stringify(result))
    yield fakeResult()
  })
  return { fake, query: fake.query, input }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
const headers = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }
const created: string[] = []

async function newTask(): Promise<Task> {
  const id = `question-task-${String(created.length + 1)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  created.push(id)
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('no task')
  }
  return task
}

async function request(method: string, path: string, body: unknown, auth: object) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...headers, ...auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: (await res.json()) as { data: unknown; error?: { detail: string } } }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { status, json } = await request(method, path, body, headers)
  if (status !== 200) {
    throw new Error(`${String(status)} ${json.error?.detail ?? ''}`)
  }
  return json.data as T
}

/** The agent's open questions once its call is recorded and its reason line set. */
async function asked(taskId: string): Promise<Question[]> {
  return vi.waitFor(
    async () => {
      const open = await call<Question[]>('GET', `/questions?task_id=${taskId}`)
      expect(open).toHaveLength(2)
      expect((await call<Task>('GET', `/tasks/${taskId}`)).blocked).not.toBeNull()
      return open
    },
    { interval: 10 },
  )
}

async function lastReply(taskId: string): Promise<unknown> {
  const page = await call<{
    messages: { kind: string; payload: { type?: string; message?: { content: { text?: string }[] } } }[]
  }>('GET', `/tasks/${taskId}/messages`)
  const replies = page.messages.filter((row) => row.kind === 'sdk' && row.payload.type === 'assistant')
  return JSON.parse(replies.at(-1)?.payload.message?.content[0]?.text ?? 'null')
}

async function answers(items: unknown[], auth: object = headers) {
  const { status, json } = await request('POST', '/questions/answers', { items }, auth)
  return { status, data: json.data as AnswerQuestionsResult, detail: json.error?.detail ?? '' }
}

const byPrompt = (open: readonly Question[], prompt: string) => {
  const found = open.find((question) => question.prompt === prompt)
  if (found === undefined) {
    throw new Error(`No question ${prompt}`)
  }
  return found
}

afterAll(async () => {
  for (const id of created) {
    await endSession(id)
  }
})

describe('AskUserQuestion', () => {
  it('records the call as a waiting group, in Needs you, with the right answer types', async () => {
    const task = await newTask()
    await runTurn(task.id, 'ask')
    const open = await asked(task.id)
    expect(open.map((q) => [q.header, q.kind, q.multi, q.status])).toEqual([
      ['Push', 'yes_no', false, 'open'],
      ['Checks', 'choice', true, 'open'],
    ])
    expect(open[0]?.group_id).toBe(open[1]?.group_id)
    expect(open[0]?.tool_use_id).toBe('toolu_ask')
    expect(open[1]?.options[0]).toEqual({ label: 'Unit', description: 'pnpm test' })
    expect((await call<Task>('GET', `/tasks/${task.id}`)).blocked).toBe(`Asks 2 questions: ${PUSH}`)

    await auditEvents.settled()
    const event = await auditEvents.latest('task.question_asked')
    expect(event?.subject_id).toBe(task.id)
    expect(event?.detail).toMatchObject({
      questions: 2,
      headers: ['Push', 'Checks'],
      kinds: ['yes_no', 'choice_multi'],
    })
  })

  it("hands back the call's own input with answers keyed by question text, and lets the agent go on", async () => {
    const task = await newTask()
    await runTurn(task.id, 'ask')
    const open = await asked(task.id)
    const result = await answers([
      { action: 'answer', id: byPrompt(open, PUSH).id, selected: ['Yes'] },
      { action: 'answer', id: byPrompt(open, CHECKS).id, selected: ['Unit', 'Lint'], other: 'and the build' },
    ])
    expect(result.data).toEqual({
      answered: 2,
      dismissed: 0,
      skipped: 0,
      resumed: [{ task_id: task.id, task_title: task.title }],
    })
    await waitIdle(task.id)
    expect(await lastReply(task.id)).toEqual({
      behavior: 'allow',
      updatedInput: { ...sdk.input, answers: { [PUSH]: 'Yes', [CHECKS]: ['Unit', 'Lint', 'and the build'] } },
    })
    expect((await call<Task>('GET', `/tasks/${task.id}`)).blocked).toBeNull()
    const history = await call<Question[]>('GET', `/questions?task_id=${task.id}&all=true`)
    expect(history.map((q) => [q.status, q.answered_by])).toEqual([
      ['answered', 'user'],
      ['answered', 'user'],
    ])
  })

  it('audits who answered and the picked labels, never the words the user wrote', async () => {
    const task = await newTask()
    await runTurn(task.id, 'ask')
    const open = await asked(task.id)
    const words = 'run the flaky suite twice'
    await answers([
      { action: 'answer', id: byPrompt(open, CHECKS).id, selected: ['E2E'], other: words },
      { action: 'answer', id: byPrompt(open, PUSH).id, selected: ['No'] },
    ])
    await waitIdle(task.id)
    await auditEvents.settled()
    const page = await auditEvents.page({ kind: 'task.question_answered', limit: 50 })
    const events = page.events.filter((event) => event.subject_id === task.id)
    expect(events).toHaveLength(2)
    const checks = events.find((event) => event.detail.question_id === byPrompt(open, CHECKS).id)
    expect(checks?.detail).toMatchObject({
      by: 'user',
      kind: 'choice_multi',
      selected: ['E2E'],
      own_words_chars: words.length,
    })
    expect(JSON.stringify(events)).not.toContain(words)
  })

  it('waits for the whole group, and tells the agent which questions the user dismissed', async () => {
    const task = await newTask()
    await runTurn(task.id, 'ask')
    const open = await asked(task.id)
    const first = await answers([
      { action: 'answer', id: byPrompt(open, PUSH).id, selected: [], other: 'Push to a branch' },
    ])
    expect(first.data.resumed).toEqual([])
    expect((await call<Task>('GET', `/tasks/${task.id}`)).blocked).toBe(`Asks a question: ${CHECKS}`)

    await answers([{ action: 'dismiss', id: byPrompt(open, CHECKS).id }])
    await waitIdle(task.id)
    const reply = (await lastReply(task.id)) as { updatedInput: { answers: Record<string, unknown> } }
    expect(reply.updatedInput.answers[PUSH]).toBe('Push to a branch')
    expect(reply.updatedInput.answers[CHECKS]).toMatch(/dismissed this question/)
    await auditEvents.settled()
    expect((await auditEvents.latest('task.question_dismissed'))?.subject_id).toBe(task.id)
  })

  it('turns the call down when the user skips every question', async () => {
    const task = await newTask()
    await runTurn(task.id, 'ask')
    const open = await asked(task.id)
    await answers(open.map((q) => ({ action: 'dismiss', id: q.id })))
    await waitIdle(task.id)
    const reply = (await lastReply(task.id)) as { behavior: string; message: string }
    expect(reply.behavior).toBe('deny')
    expect(reply.message).toMatch(/dismissed your questions/)
  })

  it('refuses answers that do not fit, and secrets in the own-words answer, before storing any', async () => {
    const task = await newTask()
    await runTurn(task.id, 'ask')
    const open = await asked(task.id)
    const push = byPrompt(open, PUSH).id
    const checks = byPrompt(open, CHECKS).id
    expect((await answers([{ action: 'answer', id: push, selected: ['Maybe'] }])).status).toBe(400)
    expect((await answers([{ action: 'answer', id: push, selected: ['Yes', 'No'] }])).status).toBe(400)
    expect((await answers([{ action: 'answer', id: push }])).status).toBe(400)
    const token = ['gh', 'p_', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8'].join('')
    const refused = await answers([
      { action: 'answer', id: push, selected: ['Yes'] },
      { action: 'answer', id: checks, selected: [], other: `use ${token}` },
    ])
    expect(refused).toMatchObject({ status: 422, detail: SECRET_ANSWER })
    expect(await call<Question[]>('GET', `/questions?task_id=${task.id}`)).toHaveLength(2)
    await stopTurn(task.id)
  })

  it('lets the EA relay an answer, recorded as relayed, and refuses agents', async () => {
    const task = await newTask()
    await runTurn(task.id, 'ask')
    const open = await asked(task.id)
    await expect(
      asAgent(task, async () => answerQuestions({ items: [{ action: 'dismiss', id: byPrompt(open, PUSH).id }] })),
    ).rejects.toThrow("Agents cannot answer the user's questions")
    const relayed = await answers(
      open.map((q) => ({ action: 'answer', id: q.id, selected: q.multi ? ['Unit'] : ['Yes'] })),
      EA_AUTH,
    )
    expect(relayed.data.answered).toBe(2)
    await waitIdle(task.id)
    const history = await call<Question[]>('GET', `/questions?task_id=${task.id}&all=true`)
    expect(history.every((q) => q.answered_by === 'ea')).toBe(true)
    await auditEvents.settled()
    expect((await auditEvents.latest('task.question_answered'))?.detail).toMatchObject({ by: 'ea', via: 'ea' })
  })

  it('expires the questions when the turn stops, and leaves answers to them out', async () => {
    const task = await newTask()
    await runTurn(task.id, 'ask')
    const open = await asked(task.id)
    await stopTurn(task.id)
    await waitIdle(task.id)
    await vi.waitFor(async () => {
      expect(await call<Question[]>('GET', `/questions?task_id=${task.id}`)).toEqual([])
    })
    expect((await call<Task>('GET', `/tasks/${task.id}`)).blocked).toBeNull()
    const late = await answers([{ action: 'answer', id: byPrompt(open, PUSH).id, selected: ['Yes'] }])
    expect(late.data).toMatchObject({ answered: 0, skipped: 1 })
    await auditEvents.settled()
    expect((await auditEvents.latest('task.question_expired'))?.subject_id).toBe(task.id)
  })

  it('expires the questions when the session ends', async () => {
    const task = await newTask()
    await runTurn(task.id, 'ask')
    await asked(task.id)
    await endSession(task.id)
    const history = await call<Question[]>('GET', `/questions?task_id=${task.id}&all=true`)
    expect(history.map((q) => q.status)).toEqual(['expired', 'expired'])
  })
})

describe('leftover questions', () => {
  it('expires open questions a restart cut off', async () => {
    const task = await newTask()
    const [stored] = await questions.open([
      {
        id: crypto.randomUUID(),
        group_id: crypto.randomUUID(),
        task_id: task.id,
        subagent_id: null,
        tool_use_id: 'toolu_left',
        position: 0,
        header: 'Left',
        prompt: 'Left over?',
        kind: 'yes_no',
        multi: false,
        options: [
          { label: 'Yes', description: null },
          { label: 'No', description: null },
        ],
      },
    ])
    await expireLeftoverQuestions()
    expect((await questions.byIds([stored?.id ?? ''])).map((q) => q.status)).toEqual(['expired'])
  })

  it('tells agents to ask through AskUserQuestion rather than in prose', () => {
    expect(questionsContext()).toMatch(/ask with the AskUserQuestion tool instead of writing the question/)
  })
})
