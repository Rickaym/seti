import { AGENT_SETTINGS, WORKSPACE_SETTINGS } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as access from '../access.js'
import { createApp } from '../app.js'
import { tasks } from '../db.js'
import { permissionRules } from '../store/permissions.js'
import { workspaceRows } from '../store/workspaces.js'
import { USER_AUTH } from '../test-auth.js'
import { undocumented, type JsonSchema } from './test-schema.js'

const source = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('../access.js', async (importOriginal) => {
  const real = await importOriginal<typeof access>()
  return { ...real, currentRequestSource: () => source.current ?? real.currentRequestSource() }
})

afterEach(() => {
  source.current = null
})

const app = createApp()
const HEADERS = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...USER_AUTH }
const TASK = 'settings-doc-agent'
await tasks.insert({ id: TASK, title: 'Doc agent', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
await permissionRules.add(TASK, 'allow', 'Bash(npm test)')
const [workspace] = await workspaceRows.list()

async function get(path: string, as: Record<string, unknown> | null = null): Promise<Response> {
  source.current = as
  return app.request(`/api/settings-doc${path}`, { headers: HEADERS })
}

async function data(path: string, as: Record<string, unknown> | null = null): Promise<Record<string, unknown>> {
  const res = await get(path, as)
  expect(res.status, path).toBe(200)
  return ((await res.json()) as { data: Record<string, unknown> }).data
}

describe("an agent's and a workspace's own settings", () => {
  it("give an agent's settings, its rules among them, and parse against their schema", async () => {
    const doc = await data(`/agents/${TASK}`)
    const agent = AGENT_SETTINGS.schema.parse(doc.agent)
    expect(agent).toMatchObject({ title: 'Doc agent', sandbox: true, memory_cap: null, dreams: true })
    expect(agent.rules.allow).toEqual(['Bash(npm test)'])
    expect(doc.revision).toMatch(/^[0-9a-f]{64}$/)
  })

  it('leave security settings out of the EA view', async () => {
    const agent = (await data(`/agents/${TASK}`, { via: 'ea' })).agent as Record<string, unknown>
    expect(agent.title).toBe('Doc agent')
    for (const key of AGENT_SETTINGS.security === 'all' ? [] : AGENT_SETTINGS.security) {
      expect(agent, key).not.toHaveProperty(key)
    }
    for (const key of ['agent', 'workspace']) {
      expect(undocumented((await data(`/schema/${key}`)) as JsonSchema), key).toEqual([])
    }
    const schema = await data('/schema/agent', { via: 'ea' })
    expect(JSON.stringify(schema)).not.toContain('allowed_hosts')
  })

  it("give a workspace's settings", async () => {
    const doc = await data(`/workspaces/${workspace?.id ?? 'none'}`)
    expect(WORKSPACE_SETTINGS.schema.parse(doc.workspace)).toMatchObject({ name: workspace?.name, dreams: true })
    expect((await get('/workspaces/missing')).status).toBe(404)
  })

  it('refuse agents, mods and devices', async () => {
    const refused = [
      { via: 'agent', taskId: TASK, title: 'Doc agent', scope: 'full' },
      { via: 'mod', id: 'sample', grants: [], scopes: {}, eventId: null, caller: null },
      { via: 'device', deviceId: 'd1', name: 'Phone', scopes: ['widget'], showNames: false },
    ]
    for (const as of refused) {
      for (const path of [`/agents/${TASK}`, '/schema/agent', `/workspaces/${workspace?.id ?? 'none'}`]) {
        expect((await get(path, as)).status, `${as.via} ${path}`).toBe(403)
      }
    }
  })
})
