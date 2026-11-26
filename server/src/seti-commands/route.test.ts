import { SETI_NAMES } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { asAgent } from '../access.js'
import { createApp } from '../app.js'
import { tasks } from '../db.js'
import { refuseDelegates } from '../ea-guard.js'
import { slashRefusal } from '../mods/commands.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { SETI_RUNNERS } from './run.js'

await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-seti-commands-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
})

const TASK = 'seti-commands-agent'
await tasks.insert({ id: TASK, title: 'Commands', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })

const app = createApp({ access: null, verify: null })
const JSON_TYPE = { 'content-type': 'application/json' }

const run = async (line: string, confirmed = false, auth: Record<string, string> = USER_AUTH) =>
  app.request(`/api/tasks/${TASK}/seti-commands`, {
    method: 'POST',
    headers: { host: 'localhost', ...auth, ...JSON_TYPE },
    body: JSON.stringify({ line, confirmed }),
  })

const task = async () => tasks.get(TASK)

describe('POST /tasks/:id/seti-commands', () => {
  it('has a runner for every command that does not open a dialog', () => {
    const missing = SETI_NAMES.filter((entry) => entry.grammar.kind !== 'open' && !(entry.name in SETI_RUNNERS))
    expect(missing.map((entry) => entry.name)).toEqual([])
    expect(Object.keys(SETI_RUNNERS).filter((name) => !SETI_NAMES.some((entry) => entry.name === name))).toEqual([])
  })

  it("runs the user's line through the settings' own functions and answers in Seti's words", async () => {
    const res = await run('/seti:PIN on')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: { line: '/seti:pin on', description: 'Turn Pin on' } })
    expect((await task())?.pinned).toBe(true)
    expect((await run('/seti:rename Fix the flaky test')).status).toBe(200)
    expect((await task())?.title).toBe('Fix the flaky test')
    expect((await run('/seti:notify off')).status).toBe(200)
    expect((await task())?.notifications_muted).toBe(true)
  })

  it('runs a change that widens access only once the user confirmed it', async () => {
    const control = await task()
    expect(control?.seti_control).toBe('self')
    const unconfirmed = await run('/seti:control full')
    expect(unconfirmed.status).toBe(409)
    expect(await unconfirmed.text()).toContain('Confirm first: Seti control: Full')
    expect((await task())?.seti_control).toBe('self')
    expect((await run('/seti:control full', true)).status).toBe(200)
    expect((await task())?.seti_control).toBe('full')
    expect((await run('/seti:control self')).status).toBe(200)
  })

  it('refuses a line the grammar does not define, and one that opens a dialog', async () => {
    const wrong = await run('/seti:pin off /seti:control full')
    expect(wrong.status).toBe(400)
    expect(await wrong.text()).toContain('takes nothing after it')
    expect((await run('/seti:settings access')).status).toBe(400)
    expect((await run('/pin on')).status).toBe(400)
    expect((await task())?.seti_control).toBe('self')
  })

  it('refuses the EA and agents, which propose changes instead', async () => {
    expect((await run('/seti:pin off', false, EA_AUTH)).status).toBe(403)
    const agent = await task()
    if (agent === undefined) {
      throw new Error('no agent')
    }
    const asked = asAgent(agent, async () => {
      refuseDelegates('run Seti commands')
      return Promise.resolve()
    })
    await expect(asked).rejects.toThrow('Agents cannot run Seti commands')
    expect((await task())?.pinned).toBe(true)
  })

  it('never takes a Seti line as a prompt, and a line inside a message runs nothing', async () => {
    expect(slashRefusal('/seti:archive')).toContain('never goes to the agent')
    expect(slashRefusal('  /SETI:pin off')).toContain('never goes to the agent')
    expect(slashRefusal('Please run /seti:pin off for me')).toBeNull()
    const queued = await app.request(`/api/tasks/${TASK}/messages`, {
      method: 'POST',
      headers: { host: 'localhost', ...USER_AUTH, ...JSON_TYPE },
      body: JSON.stringify({ prompt: '/seti:archive', interrupt: false }),
    })
    expect(queued.status).toBe(400)
    expect((await task())?.archived_at).toBeNull()
    expect((await task())?.pinned).toBe(true)
  })
})
