import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bypassOn, SANDBOX_POLICY_DEFAULT, type Task } from '@seti/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { hostLoginKey } from './claude-logins.js'
import { effectiveCompact, setTaskCompact } from './compact.js'
import { tasks } from './db.js'
import { borrowedStamp, taskBorrowedServers } from './mcp-borrowed.js'
import { taskDeniedServers } from './mcp-selection.js'
import { tokenServers } from './mcp-sign-in.js'
import { taskPluginConfigs } from './plugins.js'
import { compactSetup } from './runtimes/claude/realise.js'
import { signedInServers } from './sandbox-mcp.js'
import { registerContextProvider, sandboxStamp, systemAppend, workingDirs } from './session-options.js'
import { setupKey } from './session-spec.js'
import { sharedToolFolders } from './shared-tools.js'
import { sandboxPolicy } from './store/sandbox.js'

createApp()
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-session-spec-'))
registerContextProvider((taskId) => (taskId.endsWith('-2') ? `Context for ${taskId}.` : null))

afterAll(async () => {
  await sandboxPolicy.save(SANDBOX_POLICY_DEFAULT)
  fs.rmSync(scratch, { recursive: true, force: true })
})

const sorted = (names: Set<string>) => [...names].toSorted((a, b) => a.localeCompare(b, 'en'))

/** The setup key as session-options.ts built it before the spec existed. */
async function keyBeforeSpec(task: Task): Promise<string> {
  const dirs = workingDirs(task)
  return JSON.stringify({
    cwd: task.cwd,
    ...(dirs.length === 0 ? {} : { additionalDirectories: dirs }),
    ...(bypassOn(task.bypass_until) ? { allowDangerouslySkipPermissions: true } : {}),
    plugins: await taskPluginConfigs(task.id),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: await systemAppend(task.id) },
    mcp_denied: await taskDeniedServers(task.id),
    shared_tools: await sharedToolFolders(task),
    mcp_borrowed: borrowedStamp(await taskBorrowedServers(task)),
    mcp_signed_in: sorted(signedInServers()),
    mcp_tokens: sorted(tokenServers()),
    seti_control: task.seti_control,
    compact: compactSetup(await effectiveCompact(task.id)),
    claude_login: hostLoginKey(),
    sandbox: await sandboxStamp(task),
  })
}

let count = 0
async function newTask(sandbox: boolean): Promise<Task> {
  const id = `spec-task-${String(++count)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: scratch, worktree: false, sandbox, pr_urls: [] })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('Task was not stored')
  }
  return task
}

describe('setupKey', () => {
  it('is the key the setup gave before the spec, for plain, extended and sandboxed tasks', async () => {
    const plain = await newTask(false)
    const extended = await newTask(false)
    await setTaskCompact(extended, { auto: false, window_k: 200, threshold_pct: 70, instructions: null })
    const sandboxed = await newTask(true)
    const variants: Task[] = [
      plain,
      {
        ...extended,
        dirs: [path.join(scratch, 'other'), scratch],
        bypass_until: new Date(Date.now() + 3_600_000).toISOString(),
        session_id: 'session-1',
        seti_control: 'off',
      },
      sandboxed,
    ]
    for (const task of variants) {
      expect(await setupKey(task)).toBe(await keyBeforeSpec(task))
    }
    await sandboxPolicy.save({ ...SANDBOX_POLICY_DEFAULT, enabled: true, allowed_domains: ['example.org'] })
    expect(await setupKey(sandboxed)).toBe(await keyBeforeSpec(sandboxed))
  })
})

describe('the setup key of a spec', () => {
  it('holds the compaction rule in the layout keys always had', async () => {
    const task = await newTask(false)
    await setTaskCompact(task, { auto: false, window_k: 200, threshold_pct: 70, instructions: null })
    expect(await setupKey(task)).toContain(
      '"compact":{"settings":{"autoCompactEnabled":false,"autoCompactWindow":200000},"env":{"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":"70"}}',
    )
  })

  it('changes when bypass turns on, which only a new process can take', async () => {
    const task = await newTask(false)
    const bypass = { ...task, bypass_until: new Date(Date.now() + 3_600_000).toISOString() }
    expect(await setupKey(bypass)).not.toBe(await setupKey(task))
    expect(await setupKey(bypass)).toBe(await keyBeforeSpec(bypass))
  })
})
