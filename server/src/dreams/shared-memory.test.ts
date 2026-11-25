import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeToolCall, type DreamRun } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { findBinary } from '../binaries.js'
import { CLAUDE_HOME, WORKTREE_ROOT } from '../config.js'
import { tasks } from '../db.js'
import type { DreamHost, DreamSession, DreamSpec, DreamSupport } from '../runtimes/adapter.js'
import { claudeMemory } from '../runtimes/claude/dream.js'
import { adapterFor } from '../runtimes/registry.js'
import { projectSlug } from '../sandbox-mounts.js'
import { sandboxPolicy } from '../store/sandbox.js'
import { USER_AUTH } from '../test-auth.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-dsm-'))
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

afterAll(() => {
  claude.capabilities.dream = real
  fs.rmSync(scratch, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync(findBinary('git'), ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })

/** A runtime whose dream ends at once, and how it opened. */
function quietDream(): { dream: DreamSupport; seen: () => { spec: DreamSpec; host: DreamHost } | null } {
  let opened: { spec: DreamSpec; host: DreamHost } | null = null
  const session: DreamSession = {
    events: (async function* () {
      yield* await Promise.resolve([])
    })(),
    interrupt: async () => Promise.resolve(),
    close: () => undefined,
  }
  if (real === null) {
    throw new Error('The Claude adapter declares no dreams')
  }
  const dream: DreamSupport = {
    ...real,
    open: async (spec, _launcher, host) => {
      opened = { spec, host }
      return Promise.resolve(session)
    },
  }
  return { dream, seen: () => opened }
}

/** An agent working in a worktree of a checkout whose own memory folder holds an index. */
async function worktreeAgent(): Promise<{ id: string; checkoutMemory: string }> {
  const checkout = path.join(scratch, 'checkout')
  fs.mkdirSync(checkout, { recursive: true })
  git(checkout, 'init', '-q')
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'start')
  const id = randomUUID()
  const cwd = path.join(WORKTREE_ROOT, `checkout-${id.slice(0, 8)}`)
  git(checkout, 'worktree', 'add', '-q', '--detach', cwd)
  const index = path.join(CLAUDE_HOME, 'projects', projectSlug(checkout), 'memory')
  fs.mkdirSync(index, { recursive: true })
  fs.writeFileSync(path.join(index, 'MEMORY.md'), '- deploy through the proxy\n')
  fs.mkdirSync(claudeMemory(cwd), { recursive: true })
  await tasks.insert({ id, title: 'Lead', repo_id: null, cwd, worktree: true, pr_urls: [], sandbox: true })
  return { id, checkoutMemory: path.join(os.homedir(), '.claude', 'projects', projectSlug(checkout), 'memory') }
}

describe.skipIf(!bwrap)('a dream of an agent in a worktree', () => {
  it("names its checkout's memory as read-only, lets it be read and refuses writes to it", async () => {
    await sandboxPolicy.save({ enabled: true, allowed_domains: [], hidden_paths: [] })
    const { dream, seen } = quietDream()
    claude.capabilities.dream = dream
    const { id, checkoutMemory } = await worktreeAgent()
    const res = await app.request(`/api/tasks/${id}/dream`, {
      method: 'POST',
      headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const opened = await vi.waitFor(() => {
      const now = seen()
      if (now === null) {
        throw new Error('not opened yet')
      }
      return now
    })
    expect(opened.spec.prompt).toContain(`Read-only memory the agent's sessions also see: ${checkoutMemory}.`)
    expect(opened.spec.prompt).toMatch(/then the MEMORY\.md of each read-only memory\s+folder/)
    const file = path.join(checkoutMemory, 'MEMORY.md')
    const { gate } = opened.host
    expect(gate(claudeToolCall('r', 'Read', { file_path: file }))).toBeNull()
    expect(gate(claudeToolCall('c', 'Bash', { command: `cat ${file}` }))).toBeNull()
    expect(gate(claudeToolCall('w', 'Write', { file_path: file, content: '- x\n' }))).toMatch(/only its memory folder/)
    await vi.waitFor(async () => {
      const list = (await (
        await app.request(`/api/tasks/${id}/dreams`, { headers: { host: 'localhost', ...USER_AUTH } })
      ).json()) as {
        data: DreamRun[]
      }
      expect(list.data[0]?.state).not.toBe('running')
    })
  })
})
