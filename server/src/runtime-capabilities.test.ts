import type { Task } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { sql, tasks } from './db.js'
import { startDream } from './dreams/start.js'
import { mcpOffContext } from './mcp-off-context.js'
import { runtimeCapabilities } from './runtimes/capabilities.js'
import { setTaskSandbox } from './tasks.js'
import { USER_AUTH } from './test-auth.js'
import { renderTask } from './workspace/task-file.js'

await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-capabilities-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
})

const CODEX = 'capabilities-codex-agent'
await tasks.insert({ id: CODEX, title: 'Codex caps', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
await sql`UPDATE task SET runtime = 'codex', sandbox = 1 WHERE id = ${CODEX}`

async function codexTask(): Promise<Task> {
  const task = await tasks.get(CODEX)
  if (task === undefined) {
    throw new Error('the task was not stored')
  }
  return task
}

const app = createApp({ access: null, verify: null })
const HEADERS = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }

describe("what an agent's runtime declares", () => {
  it('serves each runtime what its adapter declares: Claude Code all, Codex none of these', async () => {
    const served = (await (await app.request('/api/runtimes/capabilities', { headers: HEADERS })).json()) as {
      data: unknown
    }
    expect(served.data).toEqual(runtimeCapabilities())
    expect(runtimeCapabilities().claude).toMatchObject({ mcp_servers: true, plugins: true, dreams: true })
    expect(runtimeCapabilities().codex).toEqual({
      label: 'Codex',
      mcp_servers: false,
      plugins: false,
      unsandboxed: false,
      compaction: false,
      side_chat: false,
      dreams: false,
      rewind: false,
    })
  })

  it('tells a Codex agent of no MCP servers it could ask for, and says its sessions load none', async () => {
    expect(await mcpOffContext(CODEX)).toBeNull()
    const text = renderTask({
      task: await codexTask(),
      handle: 'codex',
      packs: [],
      role: null,
      channels: [],
      mcp: null,
      access: { ssh: [], jumps: [], aws: { state: 'no_role', profile: 'Default' } },
    })
    expect(text).toContain("Your sessions load none of the user's MCP servers")
    expect(text).not.toContain('- On:')
  })

  it('refuses to run a Codex agent unsandboxed, a compaction rule and a dream', async () => {
    const task = await codexTask()
    await expect(setTaskSandbox(task, false)).rejects.toThrow('Codex agents have no way to run outside the sandbox')
    await setTaskSandbox(task, true)
    const compact = await app.request(`/api/tasks/${CODEX}/compact`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({ rule: null }),
    })
    expect(compact.status).toBe(409)
    await expect(startDream(task)).rejects.toThrow("The agent's runtime keeps no memory Seti can find.")
  })
})
