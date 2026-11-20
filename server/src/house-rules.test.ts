import os from 'node:os'
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { tasks } from './db.js'
import { houseRulesContext, subagentRules } from './house-rules.js'
import { guardCommand, type GuardScope } from './permission-guard.js'
import { sandboxPrompt } from './sandbox-prompt.js'
import { sessionOptions } from './session-options.js'
import { systemAppend } from './session-spec.js'

createApp()

/** What an agent pays for the block on every turn, in characters. */
const BUDGET = 1000

const scope = (sandboxed: boolean): GuardScope => ({
  home: os.homedir(),
  roots: ['/srv/agent/work'],
  protectedDirs: [],
  sandboxed,
})

async function newTask(id: string, sandbox: boolean) {
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, sandbox, pr_urls: [] })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('no task')
  }
  return task
}

const SUBAGENT_START = {
  hook_event_name: 'SubagentStart',
  agent_id: 'agent-1',
  agent_type: 'general-purpose',
  session_id: 's',
  transcript_path: '/t',
  cwd: '/tmp',
} as const

const run = async (hook: HookCallback | undefined) =>
  hook?.(SUBAGENT_START, undefined, { signal: new AbortController().signal })

describe('the house rules', () => {
  it('reach sandboxed and unsandboxed agents alike, in their system prompt', async () => {
    const sandboxed = await newTask('house-rules-sandboxed', true)
    const host = await newTask('house-rules-host', false)
    expect(await sandboxPrompt(sandboxed.id)).not.toBeNull()
    expect(await sandboxPrompt(host.id)).toBeNull()
    for (const task of [sandboxed, host]) {
      expect(await systemAppend(task.id)).toContain(houseRulesContext())
    }
  })

  it('name each enforced rule with its limit, and stay inside the size budget', () => {
    const text = houseRulesContext()
    expect(text).toContain('Never wait with a foreground sleep or a polling loop')
    expect(text).toContain(
      'run_in_background (it stops at its timeout, 30 minutes unless you set one, at most 24 hours)',
    )
    expect(text).toContain('Stop a process by its exact PID, never with pkill or killall')
    expect(text).toContain('Give rm -r a literal path inside your own directories')
    expect(text).toContain('the shell tool is Bash, and a call to bash fails')
    expect(text).toContain('Put these rules in the brief of every subagent you start')
    expect(text.split('\n')).toHaveLength(6)
    expect(text.length).toBeLessThan(BUDGET)
  })

  it('cover only what the shell guard refuses, with or without the sandbox', () => {
    for (const sandboxed of [true, false]) {
      expect(guardCommand('pkill -f vite', scope(sandboxed))).toContain('kill a PID you started')
      expect(guardCommand('killall node', scope(sandboxed))).toContain('kill a PID you started')
      expect(guardCommand('rm -rf "$BUILD_DIR"', scope(sandboxed))).toContain('by literal path')
      expect(guardCommand('rm -rf /srv/agent/work/dist', scope(sandboxed))).toBeNull()
      expect(guardCommand('kill 4242', scope(sandboxed))).toBeNull()
    }
  })

  it('reach every subagent through a SubagentStart hook of the session', async () => {
    const context = { hookEventName: 'SubagentStart', additionalContext: houseRulesContext() }
    expect(await run(subagentRules().hooks[0])).toEqual({ hookSpecificOutput: context })
    const task = await newTask('house-rules-session', false)
    const options = await sessionOptions(task, new AbortController())
    const [matcher] = options.hooks?.SubagentStart ?? []
    expect(matcher?.matcher).toBeUndefined()
    expect(await run(matcher?.hooks[0])).toEqual({ hookSpecificOutput: context })
  })
})
