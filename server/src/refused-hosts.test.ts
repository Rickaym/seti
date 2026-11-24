import { randomUUID } from 'node:crypto'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import { auditQuery, type MessageRow, type Task } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { asAgent, asMod } from './access.js'
import { createApp } from './app.js'
import { allowRefusedHost } from './change-requests.js'
import { messages, tasks } from './db.js'
import { MAX_REFUSED_HOSTS, refusalReporter } from './egress-refusals.js'
import { noteRefusedHost } from './refused-hosts.js'
import { appendMessage } from './session-ingest.js'
import { auditEvents } from './store/audit.js'
import { allowedFor } from './store/change-requests.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

/** Allow hands the agent its update at once, which starts a turn of this fake session. */
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  const fake = new FakeSdk(function* () {
    yield fakeResult()
  })
  return { ...(await importOriginal<typeof Sdk>()), query: fake.query }
})

const app = createApp()

async function newTask(): Promise<Task> {
  const id = randomUUID()
  const fields = { title: `Fetcher ${id.slice(0, 8)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] }
  await tasks.insert({ id, ...fields, sandbox: true })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('task was not stored')
  }
  return task
}

const lines = async (taskId: string) =>
  (await messages.page(taskId, 20)).messages.flatMap((row: MessageRow) =>
    row.kind === 'seti' && row.payload.refused_host !== undefined ? [row.payload] : [],
  )

const allowHost = async (task: Task, host: string, auth = USER_AUTH, scope = 'agent') =>
  app.request(`/api/tasks/${task.id}/refused-hosts`, {
    method: 'POST',
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ host, scope }),
  })

describe('hosts the sandbox refused', () => {
  it('reports the first refusal at once and later ones as a count every few seconds', () => {
    vi.useFakeTimers()
    try {
      const reports: [string, number][] = []
      const refused = refusalReporter((host, count) => reports.push([host, count]))
      refused('index.crates.io')
      for (let i = 0; i < 40; i += 1) {
        refused('index.crates.io')
      }
      refused('static.rust-lang.org')
      expect(reports).toEqual([
        ['index.crates.io', 1],
        ['static.rust-lang.org', 1],
      ])
      vi.advanceTimersByTime(5000)
      expect(reports.at(-1)).toEqual(['index.crates.io', 41])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports no more than its cap of distinct hosts', () => {
    const reports: string[] = []
    const refused = refusalReporter((host) => reports.push(host))
    for (let i = 0; i <= MAX_REFUSED_HOSTS; i += 1) {
      refused(`h${String(i)}.example.com`)
    }
    expect(reports).toHaveLength(MAX_REFUSED_HOSTS)
  })

  it('writes one quiet line per host, audited once, and counts later refusals on it', async () => {
    const task = await newTask()
    await noteRefusedHost(task.id, 'index.crates.io', 1, appendMessage)
    await noteRefusedHost(task.id, 'index.crates.io', 12, appendMessage)
    await noteRefusedHost(task.id, 'index.crates.io', 3, appendMessage)
    expect(await lines(task.id)).toEqual([
      { error: 'Sandbox refused index.crates.io', refused_host: 'index.crates.io', refused_count: 12 },
    ])
    const audited = await auditEvents.page(auditQuery.parse({ kind: 'task.host_refused', limit: 200 }))
    const own = audited.events.filter((event) => event.subject_id === task.id)
    expect(own.map((event) => event.detail)).toEqual([{ title: task.title, host: 'index.crates.io' }])
    expect((await tasks.get(task.id))?.blocked).toBeNull()
  })

  it('names only a host the user could allow, and no more hosts than the cap', async () => {
    const task = await newTask()
    const hostile = ['<img src=x onerror=alert(1)>', '*.github.com', 'a.example.com/b.example.com', 'localhost']
    for (const host of [...hostile, 'Upper.example.com', `${'a'.repeat(250)}.com`]) {
      await noteRefusedHost(task.id, host, 1, appendMessage)
    }
    expect(await lines(task.id)).toEqual([])
    for (let i = 0; i <= MAX_REFUSED_HOSTS; i += 1) {
      await noteRefusedHost(task.id, `h${String(i)}.example.com`, 1, appendMessage)
    }
    expect(await lines(task.id)).toHaveLength(MAX_REFUSED_HOSTS)
    const audited = await auditEvents.page(auditQuery.parse({ kind: 'task.host_refused', limit: 200 }))
    expect(audited.events.filter((event) => event.subject_id === task.id)).toHaveLength(MAX_REFUSED_HOSTS)
  })

  it("lets only the user's Allow host apply, and only for a host the sandbox refused", async () => {
    const task = await newTask()
    expect((await allowHost(task, 'never.example.com')).status).toBe(404)
    await noteRefusedHost(task.id, 'static.rust-lang.org', 1, appendMessage)
    expect((await allowHost(task, 'static.rust-lang.org', EA_AUTH)).status).toBe(403)
    expect((await allowHost(task, '*.rust-lang.org')).status).toBe(400)
    expect((await allowHost(task, '<b>static.rust-lang.org</b>')).status).toBe(400)
    const input = { host: 'static.rust-lang.org' }
    await expect(asAgent({ ...task, seti_control: 'full' }, async () => allowRefusedHost(task, input))).rejects.toThrow(
      /Agents cannot/,
    )
    await expect(asMod({ id: 'sample', grants: [] }, async () => allowRefusedHost(task, input))).rejects.toThrow(
      /Mods cannot/,
    )
    expect(await allowedFor(task.id)).not.toContain('static.rust-lang.org:443')
    const allowed = await allowHost(task, 'static.rust-lang.org')
    expect(allowed.status).toBe(200)
    expect(await allowedFor(task.id)).toContain('static.rust-lang.org:443')
    expect((await allowHost(task, 'static.rust-lang.org')).status).toBe(409)
  })
})
