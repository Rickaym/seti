import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DreamRun } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { findBinary } from '../binaries.js'
import { messages, tasks } from '../db.js'
import type { DreamSession, DreamSupport } from '../runtimes/adapter.js'
import { claudeMemory } from '../runtimes/claude/dream.js'
import { adapterFor } from '../runtimes/registry.js'
import { sandboxPolicy } from '../store/sandbox.js'
import { USER_AUTH } from '../test-auth.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-dnn-'))
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

/** A runtime whose dream reports at once, counting the sessions it opened. */
function countedDream(): { dream: DreamSupport; opened: () => number } {
  let opened = 0
  if (real === null) {
    throw new Error('The Claude adapter declares no dreams')
  }
  const dream: DreamSupport = {
    ...real,
    open: async (_spec, _launcher, host) => {
      opened += 1
      await host.tools[0]?.call({ summary: 'Kept one rule' })
      const session: DreamSession = {
        events: (async function* () {
          yield* await Promise.resolve([])
        })(),
        interrupt: async () => Promise.resolve(),
        close: () => undefined,
      }
      return Promise.resolve(session)
    },
  }
  return { dream, opened: () => opened }
}

async function dreamOf(id: string): Promise<DreamRun> {
  const res = await app.request(`/api/tasks/${id}/dream`, {
    method: 'POST',
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    body: '{}',
  })
  expect(res.status).toBe(200)
  return vi.waitFor(async () => {
    const list = (await (
      await app.request(`/api/tasks/${id}/dreams`, { headers: { host: 'localhost', ...USER_AUTH } })
    ).json()) as { data: DreamRun[] }
    const [run] = list.data
    if (run === undefined || run.state === 'running') {
      throw new Error('still dreaming')
    }
    return run
  })
}

describe.skipIf(!bwrap)('a dream with nothing new', () => {
  it('ends at once with a one-line report and opens no session', async () => {
    await sandboxPolicy.save({ enabled: true, allowed_domains: [], hidden_paths: [] })
    const { dream, opened } = countedDream()
    claude.capabilities.dream = dream
    const id = randomUUID()
    const cwd = path.join(scratch, 'work', id)
    fs.mkdirSync(claudeMemory(cwd), { recursive: true })
    await tasks.insert({ id, title: 'Lead', repo_id: null, cwd, worktree: false, pr_urls: [], sandbox: true })
    await messages.insert(id, { kind: 'prompt', payload: { text: 'Never push to main.' } }, [])
    expect(await dreamOf(id)).toMatchObject({ state: 'done', report: { summary: 'Kept one rule' } })
    expect(opened()).toBe(1)
    const again = await dreamOf(id)
    expect(again).toMatchObject({ state: 'done', cost_usd: 0, steps: 0, memory_changes: 0 })
    expect(again.report?.nothing_to_do).toBe(true)
    expect(again.report?.summary).toMatch(/^Nothing new/)
    expect(opened()).toBe(1)
    await messages.insert(id, { kind: 'prompt', payload: { text: 'Deploy through the proxy.' } }, [])
    await dreamOf(id)
    expect(opened()).toBe(2)
  })
})
