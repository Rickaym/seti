import fs from 'node:fs'
import path from 'node:path'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeSessionDetail, ClaudeSessionPage, SessionImportResult, Task } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { USER_AUTH } from '../test-auth.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-session-routes-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const HERE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SECOND = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const fake = vi.hoisted(() => ({ forks: 0, forked: [] as string[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const original = await importOriginal<typeof Sdk>()
  const sessions = (): Sdk.SDKSessionInfo[] => [
    { sessionId: HERE, summary: 'Here', lastModified: 3, cwd: scratch },
    { sessionId: GONE, summary: 'Gone', lastModified: 2, cwd: path.join(scratch, 'missing') },
    { sessionId: SECOND, summary: 'Second', lastModified: 1, cwd: scratch },
  ]
  return {
    ...original,
    listSessions: async () => Promise.resolve(sessions()),
    getSessionInfo: async (id: string) => Promise.resolve(sessions().find((s) => s.sessionId === id)),
    getSessionMessages: async () =>
      Promise.resolve([
        {
          type: 'user',
          uuid: 'u1',
          session_id: HERE,
          message: { role: 'user', content: 'Hello' },
          parent_tool_use_id: null,
          parent_agent_id: null,
        },
      ]),
    forkSession: async (id: string) => {
      fake.forked.push(id)
      return Promise.resolve({ sessionId: `dddddddd-dddd-4ddd-8ddd-${String(++fake.forks).padStart(12, '0')}` })
    },
  }
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const app = createApp()

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
async function send<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await res.json()) as { data: T }
  return { status: res.status, data: json.data }
}

describe('session routes', () => {
  it('validates queries, ids and bodies', async () => {
    expect((await send('GET', '/sessions?limit=0')).status).toBe(400)
    expect((await send('GET', '/sessions?offset=-1')).status).toBe(400)
    expect((await send('GET', '/sessions/not-a-uuid')).status).toBe(400)
    expect((await send('POST', `/sessions/${HERE}/import`, { pr_urls: ['https://example.com/x'] })).status).toBe(400)
    expect((await send('POST', `/sessions/${HERE}/import`, { title: '' })).status).toBe(400)
    expect((await send('POST', '/sessions/import', { sessions: [] })).status).toBe(400)
    const twice = { sessions: [{ session_id: HERE }, { session_id: HERE }] }
    expect((await send('POST', '/sessions/import', twice)).status).toBe(400)
    expect(fake.forked).toEqual([])
  })

  it('lists, describes and imports a session once', async () => {
    const list = await send<ClaudeSessionPage>('GET', '/sessions?q=e')
    expect(list.data.sessions.map((s) => s.id)).toEqual([HERE, GONE, SECOND])
    const detail = await send<ClaudeSessionDetail>('GET', `/sessions/${HERE}`)
    expect(detail.data).toMatchObject({ message_count: 1, cwd_exists: true })
    expect((await send('GET', '/sessions/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')).status).toBe(404)

    const imported = await send<Task>('POST', `/sessions/${HERE}/import`, { title: 'Continue here' })
    expect(imported.status).toBe(200)
    expect(imported.data).toMatchObject({ title: 'Continue here', source_session_id: HERE, status: 'idle' })
    expect((await send('POST', `/sessions/${HERE}/import`, {})).status).toBe(409)
    expect((await send('POST', `/sessions/${GONE}/import`, {})).status).toBe(400)
    expect(fake.forked).toEqual([HERE])

    const after = await send<ClaudeSessionPage>('GET', '/sessions')
    expect(after.data.sessions.map((s) => s.id)).toEqual([GONE, SECOND])
    const tasks = await send<Task[]>('GET', '/tasks')
    expect(tasks.data.find((t) => t.id === imported.data.id)?.source_session_id).toBe(HERE)
  })

  it('imports a batch and reports failures per session', async () => {
    const res = await send<SessionImportResult[]>('POST', '/sessions/import', {
      sessions: [{ session_id: SECOND, pr_urls: [] }, { session_id: GONE }],
    })
    expect(res.status).toBe(200)
    expect(res.data.map((r) => [r.session_id, r.task_id === null, r.error === null])).toEqual([
      [SECOND, false, true],
      [GONE, true, false],
    ])
  })
})
