import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import type { Question, SupplySecretResult, Task } from '@seti/shared'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { asAgent, asMod } from './access.js'
import { createApp } from './app.js'
import { sql, tasks } from './db.js'
import { hasKey } from './key-requests.js'
import { questionsContext } from './questions.js'
import { endSession, runTurn } from './runner.js'
import { supplySecret } from './secret-questions.js'
import { secret } from './secrets.js'
import { SECRET_TOOLS } from './seti-tools/requests.js'
import { callSetiTool } from './seti-tools/server.js'
import { auditEvents } from './store/audit.js'
import { connectionRows } from './store/connections.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

/** Calls ask_secret with the prompt's JSON as Claude Code would, storing the call and result. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeMessage, fakeResult } = await import('./fake-sdk.js')
  const fake = new FakeSdk(async function* (turn) {
    const server = await import('./seti-tools/server.js')
    const requests = await import('./seti-tools/requests.js')
    const [tool] = requests.SECRET_TOOLS
    const taskId = turn.session.options.env?.SETI_TASK_ID ?? ''
    const json = turn.text.slice(turn.text.indexOf('{'), turn.text.lastIndexOf('}') + 1)
    const input = JSON.parse(json === '' ? '{}' : json) as Record<string, unknown>
    const id = `toolu_${taskId}`
    const call = { type: 'tool_use', id, name: 'mcp__seti__ask_secret', input }
    yield fakeMessage('assistant', { parent_tool_use_id: null, message: { content: [call] } })
    const result = tool === undefined ? null : await server.callSetiTool(tool, taskId, input, turn.signal)
    const text = result?.content[0]?.text ?? ''
    const answer = { type: 'tool_result', tool_use_id: id, content: text, is_error: result?.isError === true }
    yield fakeMessage('user', { parent_tool_use_id: null, message: { role: 'user', content: [answer] } })
    yield fakeResult()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

vi.mock('./aws-access.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sandboxed: async (task: Task) => Promise.resolve(task.id.startsWith('sandboxed-')),
}))

const app = createApp()
const headers = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }
const created: string[] = []
const [askSecretTool] = SECRET_TOOLS
const fixtureValue = () => ['fixture', 'value', randomUUID()].join('-')

async function newTask(prefix = 'secret'): Promise<Task> {
  const id = `${prefix}-${randomUUID()}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  created.push(id)
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('no task')
  }
  return task
}

async function request(path: string, body: unknown, auth: object = {}) {
  const res = await app.request(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: (await res.json()) as { data: unknown; error?: { detail: string } } }
}

/** The agent's open secret question once it is recorded and its reason line set. */
async function openSecret(taskId: string): Promise<Question> {
  return vi.waitFor(
    async () => {
      const [open] = (await request(`/questions?task_id=${taskId}`, undefined)).json.data as Question[]
      if (open?.kind !== 'secret') {
        throw new Error('no secret question yet')
      }
      expect((await tasks.get(taskId))?.blocked).toMatch(/^Asks a question: the secret /)
      return open
    },
    { interval: 10 },
  )
}

const supply = async (id: string, value: string, auth: object = {}) =>
  request(`/questions/${id}/secret`, { value }, auth)

/** Everything Seti stored for the task: transcript rows, question rows and audit events. */
async function storedText(taskId: string): Promise<string> {
  const rows = await sql`SELECT payload FROM task_message WHERE task_id = ${taskId}`
  const asked = await sql`SELECT * FROM question WHERE task_id = ${taskId}`
  const audited = await sql`SELECT summary, detail FROM audit_event`
  return JSON.stringify([rows, asked, audited])
}

/** The text of the ask_secret call's result, as the transcript stored it. */
async function toolResult(taskId: string): Promise<string> {
  const rows = await sql<{ payload: string }[]>`SELECT payload FROM task_message WHERE task_id = ${taskId}`
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as { message?: { content?: { type?: string; content?: string }[] } }
    const found = payload.message?.content?.find((block) => block.type === 'tool_result')
    if (found?.content !== undefined) {
      return found.content
    }
  }
  return ''
}

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  for (const id of created) {
    await endSession(id)
  }
})

describe('ask_secret outside the sandbox', () => {
  it('writes the value to a file, hands the agent the path, and keeps the value out of every store', async () => {
    const written: string[] = []
    const spy = (chunk: unknown) => {
      written.push(String(chunk))
      return true
    }
    vi.spyOn(process.stderr, 'write').mockImplementation(spy)
    vi.spyOn(process.stdout, 'write').mockImplementation(spy)
    const task = await newTask()
    await runTurn(task.id, JSON.stringify({ name: 'AZURE_SPEECH_KEY', purpose: 'For the speech tests' }))
    const question = await openSecret(task.id)
    expect(question).toMatchObject({
      header: 'AZURE_SPEECH_KEY',
      prompt: 'For the speech tests',
      secret: { name: 'AZURE_SPEECH_KEY', hosts: [], delivery: 'file' },
    })
    const value = fixtureValue()
    const sent = await supply(question.id, value)
    expect(sent.json.data).toEqual({ task_id: task.id, task_title: task.title } satisfies SupplySecretResult)
    await waitIdle(task.id)
    const file = `${process.env.SETI_HOME ?? ''}/workspace/${task.id}/secrets/AZURE_SPEECH_KEY`
    expect(fs.readFileSync(file, 'utf8')).toBe(value)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(await toolResult(task.id)).toMatch(/^The value of AZURE_SPEECH_KEY is in \/.+\/secrets\/AZURE_SPEECH_KEY\./)
    await auditEvents.settled()
    expect((await auditEvents.latest('task.question_asked'))?.detail).toMatchObject({
      secret: true,
      name: 'AZURE_SPEECH_KEY',
    })
    expect((await auditEvents.latest('task.question_answered'))?.detail).toMatchObject({
      secret: true,
      supplied: true,
      name: 'AZURE_SPEECH_KEY',
      delivery: 'file',
    })
    const stored = await storedText(task.id)
    expect(stored).toContain('AZURE_SPEECH_KEY')
    expect(stored).not.toContain(value)
    expect(written.join('')).not.toContain(value)
    expect((await tasks.get(task.id))?.blocked).toBeNull()
  })

  it('turns the call down when the user dismisses it', async () => {
    const task = await newTask()
    await runTurn(task.id, JSON.stringify({ name: 'API_TOKEN', purpose: 'For the deploy' }))
    const question = await openSecret(task.id)
    const res = await request('/questions/answers', { items: [{ action: 'dismiss', id: question.id }] })
    expect(res.json.data).toMatchObject({ dismissed: 1, resumed: [{ task_id: task.id }] })
    await waitIdle(task.id)
    expect(await toolResult(task.id)).toMatch(/^The user dismissed your request for the secret/)
  })

  it('takes the value only on its own route, and only from the user', async () => {
    const task = await newTask()
    await runTurn(task.id, JSON.stringify({ name: 'API_TOKEN', purpose: 'For the deploy' }))
    const question = await openSecret(task.id)
    const value = fixtureValue()
    const general = await request('/questions/answers', {
      items: [{ action: 'answer', id: question.id, selected: [], other: 'some words' }],
    })
    expect(general.status).toBe(400)
    expect(general.json.error?.detail).toMatch(/asks for a secret: enter it in its own field/)
    expect((await supply(question.id, value, EA_AUTH)).status).toBe(403)
    await expect(asAgent(task, async () => supplySecret(question.id, value))).rejects.toThrow(
      'Agents cannot answer a secret question',
    )
    await expect(asMod({ id: 'sample', grants: [] }, async () => supplySecret(question.id, value))).rejects.toThrow(
      'Mods cannot answer a secret question',
    )
    expect((await openSecret(task.id)).status).toBe('open')
    expect((await supply(question.id, value)).status).toBe(200)
    await waitIdle(task.id)
  })

  it('expires the question when the call is cancelled', async () => {
    const task = await newTask()
    const cancel = new AbortController()
    const call =
      askSecretTool && callSetiTool(askSecretTool, task.id, { name: 'API_TOKEN', purpose: 'x' }, cancel.signal)
    const question = await openSecret(task.id)
    cancel.abort()
    expect((await call)?.isError).toBe(true)
    const late = await supply(question.id, fixtureValue())
    expect(late.status).toBe(409)
  })

  it('validates the name as an environment variable', async () => {
    const task = await newTask()
    for (const name of ['api-token', 'lower_case', 'HOME', '../ETC', 'X']) {
      const result = askSecretTool && (await callSetiTool(askSecretTool, task.id, { name, purpose: 'Why' }))
      expect(result?.isError, name).toBe(true)
    }
    expect((await request(`/questions?task_id=${task.id}`, undefined)).json.data).toEqual([])
  })
})

describe('ask_secret in the sandbox', () => {
  it('asks again for the hosts when the agent named none', async () => {
    const task = await newTask('sandboxed')
    const result = askSecretTool && (await callSetiTool(askSecretTool, task.id, { name: 'API_TOKEN', purpose: 'Why' }))
    expect(result?.isError).toBe(true)
    expect(result?.content[0]?.text).toMatch(/Call ask_secret again with the hosts that need it/)
  })

  it('seals the value in the secret store for the named hosts and puts it in the credential', async () => {
    const task = await newTask('sandboxed')
    const name = `SPEECH_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`
    await runTurn(task.id, JSON.stringify({ name, purpose: 'For the speech tests', hosts: ['api.example.com'] }))
    const question = await openSecret(task.id)
    expect(question.secret).toEqual({ name, hosts: ['api.example.com'], delivery: 'secret_store' })
    const value = fixtureValue()
    expect((await supply(question.id, value)).status).toBe(200)
    await waitIdle(task.id)
    const row = (await connectionRows.list()).find((entry) => entry.env === name)
    expect(row?.hosts).toEqual(['api.example.com'])
    expect(row?.slots.value === undefined ? null : await secret(row.slots.value)).toBe(value)
    expect(await hasKey(task, { kind: 'api_key', env: name, hosts: ['api.example.com'] })).toBe(true)
    expect(await toolResult(task.id)).toContain(`stored ${name} in Seti's secret store for api.example.com`)
    expect(fs.existsSync(`${process.env.SETI_HOME ?? ''}/workspace/${task.id}/secrets`)).toBe(false)
    expect(await storedText(task.id)).not.toContain(value)
  })
})

describe('the agent instruction', () => {
  it('sends secrets to ask_secret and recommendations first', () => {
    expect(questionsContext()).toContain('To ask the user for a secret, token or password, use ask_secret')
    expect(questionsContext()).toContain('end its label with (Recommended)')
  })
})
