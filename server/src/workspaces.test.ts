import { auditQuery, type Task, type Workspace, type WorkspaceEntry } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { sql, tasks } from './db.js'
import { setPlannerModel } from './planner.js'
import { SETI_TOOLS } from './seti-tools/catalog.js'
import { callSetiTool } from './seti-tools/server.js'
import { auditEvents } from './store/audit.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { migrateWith } from './test-migration.js'
import { waitIdle } from './wait-idle.js'

const sdk = await vi.hoisted(async () => {
  const fakes = await import('./fake-sdk.js')
  const fake = new fakes.FakeSdk(async function* () {
    await Promise.resolve()
    yield fakes.fakeMessage('system', {
      subtype: 'init',
      session_id: 'workspaces',
      model: 'haiku',
      permissionMode: 'default',
    })
    yield fakes.fakeResult()
  })
  return { query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()

interface Reply<T> {
  status: number
  data: T
  detail: string | undefined
}

async function send<T>(method: string, url: string, body?: unknown, auth = USER_AUTH): Promise<Reply<T>> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (res.status === 204) {
    return { status: 204, data: undefined as T, detail: undefined }
  }
  const json = (await res.json()) as { data: T; error?: { detail?: string } }
  return { status: res.status, data: json.data, detail: json.error?.detail }
}

const list = async () => (await send<WorkspaceEntry[]>('GET', '/workspaces')).data

async function create(name: string): Promise<Workspace> {
  const reply = await send<Workspace>('POST', '/workspaces', { name })
  expect(reply.status).toBe(200)
  return reply.data
}

let count = 0

async function newTask(extra: Partial<Pick<Task, 'seti_control' | 'workspace_id'>> = {}): Promise<Task> {
  const id = `workspace-task-${String(++count)}`
  await tasks.insert({
    id,
    title: `Agent ${String(count)}`,
    repo_id: null,
    cwd: '/tmp',
    worktree: false,
    pr_urls: [],
    ...extra,
  })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('task was not stored')
  }
  return task
}

async function lastAudit(kind: 'workspace' | 'task.workspace_changed') {
  return (await auditEvents.page(auditQuery.parse({ kind, limit: 1 }))).events[0]
}

const main = async () => {
  const [first] = await list()
  if (first === undefined) {
    throw new Error('no workspace')
  }
  return first
}

afterEach(() => {
  setPlannerModel(async () => Promise.reject(new Error('no model in tests')))
})

describe('the workspaces migration', () => {
  it('puts every existing agent in a first workspace named Main', async () => {
    const seed = `INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES
      ('a', 'First', '/tmp', 'idle', '2026-01-01', 'x'), ('b', 'Second', '/tmp', 'error', '2026-01-01', 'x');`
    const result = await migrateWith('workspaces', seed, async (tx) => {
      const spaces = await tx<
        { id: string; name: string; position: number }[]
      >`SELECT id, name, position FROM workspace`
      const rows = await tx<{ workspace_id: string }[]>`SELECT workspace_id FROM task ORDER BY id`
      return { spaces, rows }
    })
    expect(result.spaces).toEqual([expect.objectContaining({ name: 'Main', position: 0 })])
    expect(result.rows.map((row) => row.workspace_id)).toEqual([result.spaces[0]?.id, result.spaces[0]?.id])
  })
})

describe('workspaces', () => {
  it('lists Main first with counts of active agents and of the unseen ones that need the user', async () => {
    const first = await main()
    expect(first.name).toBe('Main')
    const waiting = await newTask()
    await tasks.endTurn(waiting.id, { status: 'error', last_error: 'failed', asking: false, closing_line: null })
    const archived = await newTask()
    await sql`UPDATE task SET archived_at = '2026-01-01' WHERE id = ${archived.id}`
    const after = (await list())[0]
    expect(after?.agents).toBe(first.agents + 1)
    expect(after?.needs_you).toBe(first.needs_you + 1)
    expect(waiting.workspace_id).toBe(first.id)
    await tasks.markSeen(waiting.id)
    expect((await list())[0]?.needs_you).toBe(first.needs_you)
  })

  it('creates, renames and refuses a name another workspace has in any case', async () => {
    const side = await create('Side project')
    expect((await list()).map((entry) => entry.name)).toContain('Side project')
    expect(side.position).toBeGreaterThan(0)
    const taken = await send('POST', '/workspaces', { name: 'side PROJECT' })
    expect(taken).toMatchObject({ status: 409, detail: 'A workspace named "side PROJECT" already exists' })
    expect((await send('POST', '/workspaces', { name: '  ' })).status).toBe(400)
    const renamed = await send<Workspace>('PATCH', `/workspaces/${side.id}`, { name: 'Side' })
    expect(renamed.data).toMatchObject({ id: side.id, name: 'Side' })
    expect(await lastAudit('workspace')).toMatchObject({
      kind: 'workspace.renamed',
      subject_type: 'workspace',
      subject_id: side.id,
      summary: 'Renamed workspace "Side project" to "Side"',
    })
    expect((await send('PATCH', `/workspaces/${(await main()).id}`, { name: 'SIDE' })).status).toBe(409)
    expect((await send('PATCH', '/workspaces/missing', { name: 'Gone' })).status).toBe(404)
  })

  it('refuses to delete a workspace that holds agents, archived ones too, and the last one', async () => {
    const busy = await create('Busy')
    const agent = await newTask({ workspace_id: busy.id })
    await sql`UPDATE task SET archived_at = '2026-01-01' WHERE id = ${agent.id}`
    const refused = await send('DELETE', `/workspaces/${busy.id}`)
    expect(refused).toMatchObject({
      status: 409,
      detail: 'Move or delete the 1 agent in "Busy" first, archived ones included',
    })
    const moved = await send<Task>('PATCH', `/tasks/${agent.id}`, { workspace_id: (await main()).id })
    expect(moved).toMatchObject({ status: 200, data: { workspace_id: (await main()).id } })
    expect((await send('DELETE', `/workspaces/${busy.id}`)).status).toBe(204)
    expect(await lastAudit('workspace')).toMatchObject({
      kind: 'workspace.deleted',
      summary: 'Deleted workspace "Busy"',
    })

    for (const entry of await list()) {
      if (entry.agents === 0 && entry.name !== 'Main') {
        await sql`UPDATE task SET workspace_id = ${(await main()).id} WHERE workspace_id = ${entry.id}`
        expect((await send('DELETE', `/workspaces/${entry.id}`)).status).toBe(204)
      }
    }
    const only = await main()
    expect(await send('DELETE', `/workspaces/${only.id}`)).toMatchObject({
      status: 409,
      detail: '"Main" is the only workspace; Seti keeps at least one',
    })
  })

  it('moves an agent with its pin, audits the move and refuses an unknown workspace', async () => {
    const away = await create('Away')
    const agent = await newTask()
    await tasks.setPinned(agent.id, true)
    const moved = await send<Task>('PATCH', `/tasks/${agent.id}`, { workspace_id: away.id }, EA_AUTH)
    expect(moved.data).toMatchObject({ workspace_id: away.id, pinned: true })
    expect(await lastAudit('task.workspace_changed')).toMatchObject({
      subject_id: agent.id,
      summary: `Moved task "${agent.title}" to workspace "Away"`,
      detail: { workspace: 'Away', previous_workspace: 'Main', via: 'ea' },
    })
    expect(await send('PATCH', `/tasks/${agent.id}`, { workspace_id: 'nowhere' })).toMatchObject({
      status: 400,
      detail: 'No workspace with that id',
    })
  })

  it('keeps every other change to an archived agent refused', async () => {
    const agent = await newTask()
    await sql`UPDATE task SET archived_at = '2026-01-01' WHERE id = ${agent.id}`
    const both = await send('PATCH', `/tasks/${agent.id}`, { workspace_id: (await main()).id, title: 'Renamed' })
    expect(both.status).toBe(409)
  })
})

describe('starting agents in workspaces', () => {
  it('starts an API agent in the workspace asked for, else the first one', async () => {
    setPlannerModel(async () => Promise.resolve({ title: 'Planned' }))
    const there = await create('Started there')
    const asked = await send<Task>('POST', '/tasks/start', { prompt: 'look around', workspace_id: there.id })
    await waitIdle(asked.data.id)
    expect(asked.data.workspace_id).toBe(there.id)
    const plain = await send<Task>('POST', '/tasks/start', { prompt: 'look around' })
    await waitIdle(plain.data.id)
    expect(plain.data.workspace_id).toBe((await main()).id)
    const unknown = await send('POST', '/tasks/start', { prompt: 'look around', workspace_id: 'nope' })
    expect(unknown).toMatchObject({ status: 400, detail: 'No workspace with that id' })
  })

  it("starts an agent's agent in its parent's workspace unless it names another", async () => {
    setPlannerModel(async () => Promise.resolve({ title: 'Child agent' }))
    const home = await create('Parent home')
    const elsewhere = await create('Elsewhere')
    const caller = await newTask({ seti_control: 'full', workspace_id: home.id })
    const tool = SETI_TOOLS.find((entry) => entry.name === 'start_task')
    if (tool === undefined) {
      throw new Error('no start_task tool')
    }
    const start = async (args: Record<string, unknown>) => {
      const result = await callSetiTool(tool, caller.id, { prompt: 'help me', ...args })
      const { id } = JSON.parse(result.content.map((block) => block.text).join('')) as { id: string }
      await waitIdle(id)
      return (await tasks.get(id))?.workspace_id
    }
    expect(await start({})).toBe(home.id)
    expect(await start({ workspace: 'Elsewhere' })).toBe(elsewhere.id)
  })
})
