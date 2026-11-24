import type { PermissionRequest, ToolCall } from '@seti/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decideCodexCall } from './codex-decide.js'
import { sql, tasks } from './db.js'
import { answerPermission } from './permission-rules.js'
import { auditEvents } from './store/audit.js'
import { codexSettings } from './store/codex-settings.js'
import { permissionRequests, permissionRules } from './store/permissions.js'

await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-codex-decide-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
})

const TASK = 'codex-decide-agent'
await tasks.insert({ id: TASK, title: 'Codex decide', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
await sql`UPDATE task SET runtime = 'codex' WHERE id = ${TASK}`
const task = await tasks.get(TASK)
if (task === undefined) {
  throw new Error('the task was not stored')
}

const shell = (command: string): ToolCall => ({
  callId: `call-${command}`,
  kind: 'shell',
  name: 'Bash',
  input: { command },
  shell: { action: 'run', command },
})

const mcp = (server: string, tool: string): ToolCall => ({
  callId: `call-${server}-${tool}`,
  kind: 'mcp',
  name: `mcp__${server}__${tool}`,
  input: { id: 7 },
  mcp: { server, tool },
})

/** The request the call raised, once it is pending. */
async function pending(): Promise<PermissionRequest> {
  let found: PermissionRequest | undefined
  await vi.waitFor(async () => {
    found = (await permissionRequests.pending(TASK))[0]
    expect(found).toBeDefined()
  })
  if (found === undefined) {
    throw new Error('no request')
  }
  return found
}

const codexCounts = async () =>
  sql<{ verdict: string; step: string; runtime: string; result: string; calls: number }[]>`SELECT verdict, step,
      runtime, result, calls FROM policy_shadow WHERE mode = 'codex' ORDER BY runtime`

beforeEach(async () => {
  await codexSettings.set({ ...(await codexSettings.get()), evaluator_decides: false })
})

describe("Seti's answer to a Codex agent's call", () => {
  it('refuses a call a guard or deny rule stops at once, and records the refusal', async () => {
    const verdict = await decideCodexCall(TASK, shell('pkill node'), new AbortController().signal)
    expect(verdict.allow).toBe(false)
    expect(await permissionRequests.pending(TASK)).toEqual([])
    const { events } = await auditEvents.page({ limit: 50, kind: 'task.permission_denied' })
    const refused = events.find((event) => event.subject_id === TASK)
    expect(refused?.detail).toMatchObject({ tool: 'Bash' })
    expect(JSON.stringify(refused)).not.toContain('pkill node')
  })

  it('asks the user about a call the rules would allow, with Allow and Deny only, and counts beside', async () => {
    const decided = decideCodexCall(TASK, shell('ls'), new AbortController().signal)
    const request = await pending()
    expect(request).toMatchObject({ tool_name: 'Bash', kind: 'tool', suggestions: [], editable: false })
    await expect(answerPermission(task, request.id, { decision: 'always' })).rejects.toThrow(/Allow or Deny/)
    await answerPermission(task, request.id, { decision: 'allow' })
    expect(await decided).toEqual({ allow: true })
    await vi.waitFor(async () => {
      expect(await codexCounts()).toContainEqual(
        expect.objectContaining({ verdict: 'allow', runtime: 'user-allow', result: 'agree' }),
      )
    })
  })

  it('refuses a note with a denial, which Codex cannot pass on, and denies without one', async () => {
    const decided = decideCodexCall(TASK, shell('git push'), new AbortController().signal)
    const request = await pending()
    const note = answerPermission(task, request.id, { decision: 'deny', message: 'Not yet.' })
    await expect(note).rejects.toThrow(/cannot pass on a note/)
    await answerPermission(task, request.id, { decision: 'deny' })
    expect((await decided).allow).toBe(false)
  })

  it("lets Seti's rules allow a call without the user once the user turned that on", async () => {
    await codexSettings.set({ ...(await codexSettings.get()), evaluator_decides: true })
    expect(await decideCodexCall(TASK, shell('ls'), new AbortController().signal)).toEqual({ allow: true })
    expect(await permissionRequests.pending(TASK)).toEqual([])
  })

  it("allows a tool-server call without the user only by the user's rule that names it", async () => {
    await codexSettings.set({ ...(await codexSettings.get()), evaluator_decides: true })
    const bash = (await permissionRules.add(TASK, 'allow', 'Bash')).rule
    const asked = decideCodexCall(TASK, mcp('tracker', 'get_issue'), new AbortController().signal)
    const request = await pending()
    expect(request.tool_name).toBe('mcp__tracker__get_issue')
    await answerPermission(task, request.id, { decision: 'deny' })
    expect((await asked).allow).toBe(false)
    const tool = (await permissionRules.add(TASK, 'allow', 'mcp__tracker__get_issue')).rule
    const server = (await permissionRules.add(TASK, 'allow', 'mcp__docs')).rule
    const signal = new AbortController().signal
    expect(await decideCodexCall(TASK, mcp('tracker', 'get_issue'), signal)).toEqual({ allow: true })
    expect(await decideCodexCall(TASK, mcp('docs', 'write_page'), signal)).toEqual({ allow: true })
    const other = decideCodexCall(TASK, mcp('tracker', 'close_issue'), signal)
    await answerPermission(task, (await pending()).id, { decision: 'deny' })
    expect((await other).allow).toBe(false)
    for (const rule of [bash, tool, server]) {
      await permissionRules.remove(TASK, rule.id)
    }
  })

  it('drops the request when Codex stops waiting, and counts nothing for it', async () => {
    const before = await codexCounts()
    const control = new AbortController()
    const decided = decideCodexCall(TASK, shell('make'), control.signal)
    await pending()
    control.abort()
    expect((await decided).allow).toBe(false)
    expect(await permissionRequests.pending(TASK)).toEqual([])
    expect(await codexCounts()).toEqual(before)
  })
})
