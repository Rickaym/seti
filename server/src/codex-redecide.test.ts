import type { PermissionRequest, ToolCall } from '@seti/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decideCodexCall } from './codex-decide.js'
import { updateCodexSettings } from './codex-status.js'
import { sql, tasks } from './db.js'
import { answerPermission } from './permission-rules.js'
import { auditEvents } from './store/audit.js'
import { codexSettings } from './store/codex-settings.js'
import { permissionRequests, permissionRules } from './store/permissions.js'

await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-codex-redecide-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
})

let seq = 0

/** A fresh Codex agent per test, so requests and audit records never mix. */
async function codexAgent() {
  seq += 1
  const id = `codex-redecide-${String(seq)}`
  await tasks.insert({ id, title: `Redecide ${String(seq)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  await sql`UPDATE task SET runtime = 'codex' WHERE id = ${id}`
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('the task was not stored')
  }
  return task
}

const shell = (command: string): ToolCall => ({
  callId: `call-${command}`,
  kind: 'shell',
  name: 'Bash',
  input: { command },
  shell: { action: 'run', command },
})

const MCP: ToolCall = {
  callId: 'call-mcp',
  kind: 'mcp',
  name: 'mcp__tracker__close_issue',
  input: { id: 7 },
  mcp: { server: 'tracker', tool: 'close_issue' },
}

/** The agent's pending requests once `count` of them wait. */
async function pendingOf(taskId: string, count: number): Promise<PermissionRequest[]> {
  let found: PermissionRequest[] = []
  await vi.waitFor(async () => {
    found = await permissionRequests.pending(taskId)
    expect(found).toHaveLength(count)
  })
  return found
}

const answersOf = async (taskId: string) => {
  const { events } = await auditEvents.page({ limit: 200 })
  return events.filter(
    (event) =>
      event.subject_id === taskId && ['task.permission_allowed', 'task.permission_denied'].includes(event.kind),
  )
}

const stateOf = async (id: string) => (await permissionRequests.get(id))?.state

const rulesOn = async () => updateCodexSettings({ evaluator_decides: true })

beforeEach(async () => {
  await codexSettings.set({ ...(await codexSettings.get()), evaluator_decides: false })
})

describe('turning Rules decide on for Codex agents', () => {
  it('answers the waiting calls the rules decide, keeps the rest waiting, and audits each once', async () => {
    const task = await codexAgent()
    const signal = new AbortController().signal
    const listed = decideCodexCall(task.id, shell('ls'), signal)
    const deploy = decideCodexCall(task.id, shell('make deploy'), signal)
    const tracker = decideCodexCall(task.id, MCP, signal)
    const waiting = await pendingOf(task.id, 3)
    const deny = (await permissionRules.add(task.id, 'deny', 'Bash(make deploy:*)')).rule

    await rulesOn()
    expect(await listed).toEqual({ allow: true })
    expect(await deploy).toEqual({ allow: false, message: 'A deny rule matches' })
    const left = await permissionRequests.pending(task.id)
    expect(left.map((request) => request.tool_name)).toEqual(['mcp__tracker__close_issue'])
    const byTool = new Map(waiting.map((request) => [request.summary, request.id]))
    expect(await stateOf(byTool.get('ls') ?? '')).toBe('allowed')
    expect(await stateOf(byTool.get('make deploy') ?? '')).toBe('denied')

    await updateCodexSettings({ evaluator_decides: false })
    await rulesOn()
    const answers = await answersOf(task.id)
    const seen = answers.map((event) => `${event.kind} ${event.actor} ${String(event.detail.by)}`)
    expect(seen.toSorted((a, b) => a.localeCompare(b))).toEqual([
      'task.permission_allowed system rules',
      'task.permission_denied system rules',
    ])
    expect(JSON.stringify(answers)).not.toContain('make deploy')

    await answerPermission(task, left[0]?.id ?? '', { decision: 'deny' })
    expect((await tracker).allow).toBe(false)
    await permissionRules.remove(task.id, deny.id)
  })

  it('lets exactly one answer reach the agent when the user answers at the same moment', async () => {
    for (const userFirst of [true, false]) {
      const task = await codexAgent()
      const decided = decideCodexCall(task.id, shell('ls'), new AbortController().signal)
      const [request] = await pendingOf(task.id, 1)
      const id = request?.id ?? ''
      const user = async () => answerPermission(task, id, { decision: 'deny' })
      const rules = userFirst ? null : rulesOn()
      const answer = user()
      const [answered] = await Promise.allSettled([answer, rules ?? rulesOn()])
      const verdict = await decided
      const state = await stateOf(id)
      expect(state).toBe(answered.status === 'fulfilled' ? 'denied' : 'allowed')
      expect(verdict.allow).toBe(state === 'allowed')
      expect(await answersOf(task.id)).toHaveLength(1)
      await codexSettings.set({ ...(await codexSettings.get()), evaluator_decides: false })
    }
  })

  it('leaves a request alone whose turn was stopped meanwhile', async () => {
    const task = await codexAgent()
    const control = new AbortController()
    const decided = decideCodexCall(task.id, shell('ls'), control.signal)
    const [request] = await pendingOf(task.id, 1)
    control.abort()
    expect((await decided).allow).toBe(false)
    await rulesOn()
    expect(await stateOf(request?.id ?? '')).toBe('cancelled')
    expect(await answersOf(task.id)).toEqual([])
  })
})
