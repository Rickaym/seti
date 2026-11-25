import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { DreamRun, Task } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { findBinary } from './binaries.js'
import { CLAUDE_HOME, WORKTREE_ROOT } from './config.js'
import { tasks } from './db.js'
import type { DreamSession, DreamSpec, DreamSupport } from './runtimes/adapter.js'
import { claudeMemory } from './runtimes/claude/dream.js'
import { adapterFor } from './runtimes/registry.js'
import { projectSlug } from './sandbox-mounts.js'
import { sandboxPrompt } from './sandbox-prompt.js'
import { sessionOptions } from './session-spec.js'
import { sandboxPolicy } from './store/sandbox.js'
import { removeTaskSandbox } from './task-sandbox.js'
import { USER_AUTH } from './test-auth.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-agent-memory-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const bwrap = (() => {
  try {
    execFileSync(findBinary('bwrap'), ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', 'true'])
    return true
  } catch {
    return false
  }
})()

const app = createApp()
const claude = adapterFor('claude')
const real = claude.capabilities.dream
const git = (cwd: string, ...args: string[]) =>
  execFileSync(findBinary('git'), ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })
const checkout = path.join(scratch, 'checkout')
const shared = path.join('projects', projectSlug(checkout), 'memory')
const ids: string[] = []

beforeAll(async () => {
  fs.mkdirSync(checkout, { recursive: true })
  git(checkout, 'init', '-q')
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'start')
  fs.mkdirSync(path.join(CLAUDE_HOME, shared), { recursive: true })
  fs.writeFileSync(path.join(CLAUDE_HOME, shared, 'MEMORY.md'), '- every session of the repository keeps this\n')
  await sandboxPolicy.save({ enabled: true, allowed_domains: [], hidden_paths: [] })
})

afterAll(async () => {
  claude.capabilities.dream = real
  for (const id of ids) {
    await removeTaskSandbox(id)
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

/** An agent working in a worktree of the checkout, sandboxed unless told otherwise. */
async function worktreeAgent(sandbox = true): Promise<Task> {
  const id = randomUUID()
  ids.push(id)
  const cwd = path.join(WORKTREE_ROOT, `checkout-${id.slice(0, 8)}`)
  git(checkout, 'worktree', 'add', '-q', '--detach', cwd)
  fs.mkdirSync(claudeMemory(cwd), { recursive: true })
  await tasks.insert({ id, title: 'Lead', repo_id: null, cwd, worktree: true, pr_urls: [], sandbox })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('The agent was not stored')
  }
  return task
}

/** A dream that writes one note into the memory folder its prompt names, and how it opened. */
function notingDream(): { dream: DreamSupport; spec: () => DreamSpec | null } {
  let opened: DreamSpec | null = null
  if (real === null) {
    throw new Error('The Claude adapter declares no dreams')
  }
  const session: DreamSession = {
    events: (async function* () {
      yield* await Promise.resolve([])
    })(),
    interrupt: async () => Promise.resolve(),
    close: () => undefined,
  }
  const dream: DreamSupport = {
    ...real,
    open: async (spec, _launcher, host) => {
      opened = spec
      fs.writeFileSync(path.join(claudeMemory(spec.cwd), 'MEMORY.md'), '- deploy through the proxy\n')
      await host.tools[0]?.call({ summary: 'Kept one rule' })
      return Promise.resolve(session)
    },
  }
  return { dream, spec: () => opened }
}

async function dreamOf(id: string): Promise<DreamRun> {
  const headers = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }
  const res = await app.request(`/api/tasks/${id}/dream`, { method: 'POST', headers, body: '{}' })
  expect(res.status).toBe(200)
  return vi.waitFor(async () => {
    const list = (await (await app.request(`/api/tasks/${id}/dreams`, { headers })).json()) as { data: DreamRun[] }
    const [run] = list.data
    if (run === undefined || run.state === 'running') {
      throw new Error('still dreaming')
    }
    return run
  })
}

/** The auto memory index a real Claude Code process of the agent loads, asking no model. */
async function loadedIndex(task: Task): Promise<string[]> {
  const abort = new AbortController()
  const options = await sessionOptions(task, abort)
  const silent = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
      abort.signal.addEventListener('abort', () => {
        resolve()
      })
    })
    yield* []
  })()
  const env = {
    ...options.env,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  const session = query({ prompt: silent, options: { ...options, env } })
  try {
    const usage = await session.getContextUsage()
    return usage.memoryFiles.filter((file) => file.type === 'AutoMem').map((file) => file.path)
  } finally {
    abort.abort()
    session.close()
  }
}

describe.skipIf(!bwrap)("a sandboxed agent's own memory", () => {
  it('is what a worktree agent loads in its real sandbox: the folder its dream edits', async () => {
    const notes = notingDream()
    claude.capabilities.dream = notes.dream
    const task = await worktreeAgent()
    const run = await dreamOf(task.id)
    expect(run.memory_changes).toBe(1)
    expect(run.report?.found).toEqual([])
    const edited = /Memory folder: (\S+)\./.exec(notes.spec()?.prompt ?? '')?.[1]
    expect(edited).toBe(path.join(os.homedir(), '.claude', 'projects', projectSlug(task.cwd), 'memory'))
    expect(await loadedIndex(task)).toEqual([path.join(edited ?? '', 'MEMORY.md')])
  }, 60_000)

  it("names the repository's shared index, read-only, in a sandboxed agent's prompt", async () => {
    const task = await worktreeAgent()
    const index = path.join(os.homedir(), '.claude', shared, 'MEMORY.md')
    expect(await sandboxPrompt(task.id)).toContain(`Memory that other sessions of your repository keep is read-only`)
    expect(await sandboxPrompt(task.id)).toContain(index)
  })

  it("leaves an unsandboxed agent's memory to Claude Code, as before", async () => {
    const task = await worktreeAgent(false)
    const options = await sessionOptions(task, new AbortController())
    expect(options.settings).not.toHaveProperty('autoMemoryDirectory')
    expect(await sandboxPrompt(task.id)).toBeNull()
  })
})
