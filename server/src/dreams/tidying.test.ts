import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { claudeToolCall, type DreamRun, type Revision } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { findBinary } from '../binaries.js'
import { tasks } from '../db.js'
import type { DreamHost, DreamSpec, DreamSupport } from '../runtimes/adapter.js'
import { reportedCost } from '../runtimes/claude/cost.js'
import { claudeMemory } from '../runtimes/claude/dream.js'
import { claudeSession } from '../runtimes/claude/session.js'
import { adapterFor } from '../runtimes/registry.js'
import { sandboxPolicy } from '../store/sandbox.js'
import { USER_AUTH } from '../test-auth.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-dream-tidy-'))
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

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
async function send<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const parsed = (await res.json()) as { data?: T; error?: { detail: string } }
  return { status: res.status, data: (parsed.data ?? parsed.error?.detail ?? null) as T }
}

const STALE = '- Deploy staging with scripts/stage.sh [seen 2026-10-01]\n'
const FEEDBACK = '- The user wants PR bodies short: "two lines, no lists" [user 2026-11-02]\n'
const INDEX = [
  '- [Deploy](deploy.md) - deploy through the proxy',
  '- [Deploy, port](deploy-2.md) - deploy through the proxy on 443',
  '- [Staging](staging.md) - staging deploy script',
  '- [Review](feedback-review.md) - how the user wants PR bodies',
].join('\n')

const TIDIED = [
  'Merged deploy-2.md into deploy.md: both said to deploy through the proxy.',
  'Removed staging.md: scripts/stage.sh is gone from the repository.',
  'Moved the proxy port out of MEMORY.md into deploy.md: detail belongs in the topic file.',
]

/** The writes a tidying dream makes, each through the gate as Claude Code would ask it. */
const TIDY: [string, string][] = [
  ['deploy.md', '- Deploy through the proxy, port 443 [seen 2026-11-25]\n'],
  ['deploy-2.md', ''],
  ['staging.md', ''],
  ['MEMORY.md', '- [Deploy](deploy.md) - deploy through the proxy\n- [Review](feedback-review.md) - PR bodies\n'],
]

/** Claude Code's SDK as a dream that tidies: merges, removes, keeps feedback, then reports. */
function tidyingTransport(spec: DreamSpec, host: DreamHost): Query {
  async function* messages(): AsyncGenerator<SDKMessage> {
    const inside = /Memory folder: (\S+)\./.exec(spec.prompt)?.[1] ?? ''
    for (const [name, content] of TIDY) {
      const call = claudeToolCall(`w-${name}`, 'Write', { file_path: path.join(inside, name), content })
      if (host.gate(call) === null) {
        fs.writeFileSync(path.join(claudeMemory(spec.cwd), name), content)
      }
    }
    const over = await host.tools[0]?.call({
      summary: 'x',
      tidied: Array.from({ length: 21 }, (_, i) => `Line ${String(i)}`),
    })
    expect(over).toMatch(/^Not stored/)
    await host.tools[0]?.call({ summary: 'Merged the deploy notes and removed a stale one', tidied: TIDIED })
    const base = { session_id: 's', uuid: randomUUID(), num_turns: 9, duration_ms: 900, is_error: false }
    yield await Promise.resolve({ ...base, type: 'result', subtype: 'success', result: 'done' } as SDKMessage)
  }
  const query = Object.assign(messages(), { interrupt: async () => Promise.resolve(), close: () => undefined })
  return query as unknown as Query
}

function tidyingDream(): { dream: DreamSupport; spec: () => DreamSpec | null } {
  let opened: DreamSpec | null = null
  const dream: DreamSupport = {
    memory: claudeMemory,
    reportedCost,
    open: async (spec, _launcher, host) => {
      opened = spec
      return Promise.resolve(claudeSession(tidyingTransport(spec, host), false))
    },
  }
  return { dream, spec: () => opened }
}

async function agent(): Promise<{ id: string; memory: string }> {
  const id = randomUUID()
  const cwd = path.join(scratch, 'work', id)
  fs.mkdirSync(cwd, { recursive: true })
  const memory = claudeMemory(cwd)
  fs.mkdirSync(memory, { recursive: true })
  const files: Record<string, string> = {
    'MEMORY.md': `${INDEX}\n`,
    'deploy.md': '- Deploy through the proxy [seen 2026-11-20]\n',
    'deploy-2.md': '- Deploy through the proxy on port 443 [seen 2026-11-21]\n',
    'staging.md': STALE,
    'feedback-review.md': FEEDBACK,
  }
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(memory, name), text)
  }
  await tasks.insert({ id, title: 'Lead', repo_id: null, cwd, worktree: false, pr_urls: [], sandbox: true })
  return { id, memory }
}

async function dreamOf(id: string): Promise<DreamRun> {
  expect((await send<DreamRun>('POST', `/tasks/${id}/dream`, {})).status).toBe(200)
  return vi.waitFor(
    async () => {
      const [run] = (await send<DreamRun[]>('GET', `/tasks/${id}/dreams`)).data
      if (run === undefined || run.state === 'running') {
        throw new Error('still dreaming')
      }
      return run
    },
    { timeout: 15_000, interval: 100 },
  )
}

describe.skipIf(!bwrap)('a dream that tidies old memory', () => {
  it('asks for a review that keeps feedback and reads the whole day', async () => {
    await sandboxPolicy.save({ enabled: true, allowed_domains: [], hidden_paths: [] })
    const tidy = tidyingDream()
    claude.capabilities.dream = tidy.dream
    const { id } = await agent()
    await dreamOf(id)
    const spec = tidy.spec()
    expect(spec?.append).toMatch(/Why tidy: memory helps only while the next session can trust it\./)
    expect(spec?.prompt).toMatch(/4\. Review what is already there, not only what the day touched\./)
    expect(spec?.prompt).toMatch(/Never remove a note only\s+because the day did not mention it/)
    expect(spec?.prompt).toMatch(/Keep feedback and the user's\s+preferences unless/)
    expect(spec?.prompt).toMatch(/Read the whole digest, from its first line to its last/)
  })

  it('reports each removal and merge with its reason, and every one can be undone', async () => {
    claude.capabilities.dream = tidyingDream().dream
    const { id, memory } = await agent()
    const run = await dreamOf(id)
    expect(run).toMatchObject({ state: 'done', memory_changes: 4 })
    expect(run.report?.tidied).toEqual(TIDIED)
    expect(fs.existsSync(path.join(memory, 'staging.md'))).toBe(false)
    expect(fs.existsSync(path.join(memory, 'deploy-2.md'))).toBe(false)
    expect(fs.readFileSync(path.join(memory, 'feedback-review.md'), 'utf8')).toBe(FEEDBACK)
    const report = fs.readFileSync(
      path.join(scratch, 'seti', 'workspace', id, 'dreams', run.night, 'report.md'),
      'utf8',
    )
    expect(report).toContain(['## Tidied', '', ...TIDIED.map((line) => `- ${line}`)].join('\n'))
    const history = (await send<Revision[]>('GET', `/revisions?object_type=memory_file&task_id=${id}`)).data
    expect(history.map((revision) => revision.object_id).toSorted((a, b) => a.localeCompare(b, 'en'))).toEqual(
      ['deploy-2.md', 'deploy.md', 'MEMORY.md', 'staging.md'].map((name) => `${id}:${name}`),
    )
    const removed = history.find((revision) => revision.object_id === `${id}:staging.md`)
    expect((await send<Revision>('POST', `/revisions/${String(removed?.id)}/revert`, {})).status).toBe(200)
    expect(fs.readFileSync(path.join(memory, 'staging.md'), 'utf8')).toBe(STALE)
  })
})
