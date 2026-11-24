import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { addPermissionRuleInput, type PermissionRequest, type Task, type ToolCall } from '@seti/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decideCodexCall } from './codex-decide.js'
import { sql, tasks } from './db.js'
import { composeRules } from './permission-policy.js'
import { answerPermission } from './permission-rules.js'
import { pushCall } from './push-asks.js'
import { codexSettings } from './store/codex-settings.js'
import { permissionRequests, permissionRules } from './store/permissions.js'

vi.mock('./github.js', () => ({
  viewerLogin: async () => Promise.resolve('me'),
  gh: async () => Promise.resolve('my-org\n'),
}))

const root = mkdtempSync(path.join(tmpdir(), 'seti-push-asks-'))
// eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args])
git('init', '-q', '-b', 'main')
git('remote', 'add', 'origin', 'https://github.com/my-org/tool.git')
git('remote', 'add', 'theirs', 'git@github.com:other/tool.git')

/** A Claude agent and a Codex agent working in the same clone. */
async function agent(id: string, runtime: 'claude' | 'codex'): Promise<Task> {
  await tasks.insert({ id, title: id, repo_id: null, cwd: root, worktree: false, pr_urls: [] })
  await sql`UPDATE task SET runtime = ${runtime} WHERE id = ${id}`
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('the task was not stored')
  }
  return task
}

const claude = await agent('push-claude', 'claude')
const codex = await agent('push-codex', 'codex')

const shell = (command: string): ToolCall => ({
  callId: `call-${command}`,
  kind: 'shell',
  name: 'Bash',
  input: { command, cwd: root },
  shell: { action: 'run', command },
})

async function pending(taskId: string): Promise<PermissionRequest> {
  let found: PermissionRequest | undefined
  await vi.waitFor(async () => {
    found = (await permissionRequests.pending(taskId))[0]
    expect(found).toBeDefined()
  })
  if (found === undefined) {
    throw new Error('no request')
  }
  return found
}

const signal = new AbortController().signal
const bash = (command: string) => ({ tool: 'Bash', input: { command }, cwd: root })

beforeEach(async () => {
  await codexSettings.set({ ...(await codexSettings.get()), evaluator_decides: true })
})

describe('a push outside the user organisations', () => {
  it("asks for a Claude agent through its hook, offering the owner's PushTo rule", async () => {
    expect(await pushCall(claude, bash('git push origin main'), signal)).toEqual({})
    const held = pushCall(claude, bash('git push theirs main'), signal)
    const request = await pending(claude.id)
    expect(request.reason).toBe('Push to other/tool, outside your organisations')
    expect(request.suggestions).toEqual(['PushTo(other)'])
    await answerPermission(claude, request.id, { decision: 'deny' })
    expect(await held).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })

    const again = pushCall(claude, bash('git push theirs main'), signal)
    await answerPermission(claude, (await pending(claude.id)).id, { decision: 'always', scope: 'agent' })
    expect(await again).toEqual({})
    expect(await pushCall(claude, bash('git push theirs main'), signal)).toEqual({})
    for (const rule of await permissionRules.list(claude.id)) {
      await permissionRules.remove(claude.id, rule.id)
    }
  })

  it('asks for a Codex agent even while the rules decide, and not for its own repositories', async () => {
    expect(await decideCodexCall(codex.id, shell('git push origin main'), signal)).toEqual({ allow: true })
    expect(await decideCodexCall(codex.id, shell('cd . && git push -u origin feat/x'), signal)).toEqual({
      allow: true,
    })
    const held = decideCodexCall(codex.id, shell('gh repo fork other/tool'), signal)
    const request = await pending(codex.id)
    expect(request.reason).toBe('Fork other/tool, outside your organisations')
    await answerPermission(codex, request.id, { decision: 'allow' })
    expect(await held).toEqual({ allow: true })
  })

  it("keeps PushTo rules the user's own allow, out of the runtimes' rule lists", () => {
    expect(addPermissionRuleInput.safeParse({ behavior: 'allow', rule: 'PushTo(acme)' }).success).toBe(true)
    expect(addPermissionRuleInput.safeParse({ behavior: 'deny', rule: 'PushTo(acme)' }).success).toBe(false)
    expect(addPermissionRuleInput.safeParse({ behavior: 'allow', rule: 'PushTo(a b)' }).success).toBe(false)
    const rules = composeRules({
      builtIn: [],
      sandboxed: true,
      stored: [{ behavior: 'allow', rule: 'PushTo(acme)' }],
      fixedDeny: [],
    })
    expect(rules.allow).toEqual([])
  })
})
