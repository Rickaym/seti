import fs from 'node:fs'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { AuditPage, ContextPack, ContextPackSummary, Task } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { binaryPath } from './binaries.js'
import { tasks } from './db.js'
import { setInputMode } from './inputs.js'
import { sessionOptions, setupKey } from './session-options.js'
import { packForTask, renderGuide, workspaceLine } from './seti-guide.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { migrateWith } from './test-migration.js'
import { workspaceDir } from './workspace/dir.js'
import { openWorkspace } from './workspace/engine.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-guide-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  query: (_params: { prompt: unknown; options?: Options }) => {
    const session = (async function* () {
      await Promise.resolve()
      yield* []
    })()
    return Object.assign(session, { close: () => undefined })
  },
}))

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const only =
  (...names: string[]) =>
  (name: string) =>
    names.includes(name)

describe('renderGuide', () => {
  it('keeps to terse sections in plain ASCII', () => {
    const text = renderGuide({ mode: 'wake', has: only('jq', 'rg', 'fd') })
    expect(text.startsWith('# Seti guide\n')).toBe(true)
    for (const heading of ['Workspace ($SETI_WORKSPACE)', 'Group chat', 'Tools']) {
      expect(text).toContain(`\n## ${heading}\n`)
    }
    expect(text).toContain('run_in_background: true')
    expect(text).toContain('Ask @ea')
    expect(text).toMatch(/^[\x20-\x7e\n]*$/)
    expect(text.length).toBeLessThan(2000)
  })

  it('tells every agent how to send and answer a direct message', () => {
    for (const setiTools of [false, true]) {
      const text = renderGuide({ mode: 'wake', setiTools, has: only() })
      expect(text).toContain('start the append with the line `direct @handle`')
      expect(text.includes('post_team_chat with to')).toBe(setiTools)
    }
  })

  it('hands files to agents and the EA with send_file, with or without Seti control', () => {
    for (const setiTools of [false, true]) {
      const text = renderGuide({ mode: 'wake', setiTools, has: only() })
      expect(text).toContain('- inbox/<sender>/: files other agents sent you.')
      expect(text).toContain('Send files to agents or @ea with seti send_file; never paste them')
    }
  })

  it('tells only a waking task to end the turn after a push', () => {
    expect(renderGuide({ mode: 'wake', has: only() })).toContain('After a push, end the turn')
    for (const mode of ['queue', 'off', null] as const) {
      const text = renderGuide({ mode, has: only() })
      expect(text).toContain('No sleep, until or watch loops')
      expect(text).not.toContain('After a push')
    }
  })

  it('sends user files through the workspace and secrets through the proxy only when sandboxed', () => {
    const sandboxed = renderGuide({ mode: 'wake', has: only() })
    expect(sandboxed).toContain('\n## Files with the user\n')
    expect(sandboxed).toContain('never at a host path')
    expect(sandboxed).toContain('as a connection in Settings, Connections')
    const open = renderGuide({ mode: 'wake', has: only(), sandboxed: false })
    expect(open).not.toContain('Settings, Connections')
    expect(open).toContain('read it from uploads/ without printing it')
  })

  it('names only the tools the host has', () => {
    const none = renderGuide({ mode: 'wake', has: only() })
    expect(none).not.toMatch(/\bjq\b|\brg\b/)
    expect(none).toContain('Batch independent reads')
    expect(renderGuide({ mode: 'wake', has: only('jq', 'rg', 'fd') })).toContain(
      '- Use jq or gh --jq for JSON; rg and fd in scripts, pipes and xargs.',
    )
    expect(renderGuide({ mode: 'wake', has: only('rg', 'fdfind') })).toContain(
      '- Use rg and fdfind in scripts, pipes and xargs.',
    )
    expect(renderGuide({ mode: 'wake', has: only('jq') })).toContain('- Use jq or gh --jq for JSON.')
  })
})

describe('binaryPath', () => {
  it('finds a program on PATH and returns null for a missing one', () => {
    expect(binaryPath('sh', '/usr/bin:/bin')).toMatch(/\/sh$/)
    expect(binaryPath('seti-no-such-tool', '/usr/bin:/bin')).toBeNull()
    expect(binaryPath('sh', 'relative/dir')).toBeNull()
  })
})

const app = createApp()

interface Reply<T> {
  status: number
  data: T
}

async function send<T = unknown>(
  method: string,
  url: string,
  body?: unknown,
  auth: Record<string, string> = USER_AUTH,
): Promise<Reply<T>> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, data: (text === '' ? null : (JSON.parse(text) as { data: T }).data) as T }
}

const guidePack = async () => {
  const pack = (await send<ContextPack[]>('GET', '/context/packs')).data.find(
    (found) => found.builtin && found.kind === 'reference',
  )
  if (pack === undefined) {
    throw new Error('no built-in pack')
  }
  return pack
}

const newTask = async (extra: Record<string, unknown> = {}) =>
  (await send<Task>('POST', '/tasks', { title: 'Guide', prompt: 'Hi', cwd: scratch, ...extra })).data

const linkedNames = async (taskId: string) =>
  (await send<ContextPackSummary[]>('GET', `/tasks/${taskId}/context-packs`)).data.map((pack) => pack.name)

async function appendOf(task: Task): Promise<string> {
  const { systemPrompt } = await sessionOptions(task, new AbortController())
  if (typeof systemPrompt !== 'object' || Array.isArray(systemPrompt) || systemPrompt.type !== 'preset') {
    throw new Error('no preset system prompt')
  }
  return systemPrompt.append ?? ''
}

const fresh = async (id: string) => {
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('no task')
  }
  return task
}

describe('the built-in Seti guide pack', () => {
  it('ships linked by default, read-only, shown as an agent that wakes reads it', async () => {
    const pack = await guidePack()
    expect(pack).toMatchObject({ name: 'Seti guide', builtin: true, linked_by_default: true })
    expect(pack.body).toBe(renderGuide({ mode: 'wake' }))
    const edit = { name: 'Seti guide', description: '', body: 'mine' }
    expect((await send('PUT', `/context/packs/${pack.id}`, edit)).status).toBe(403)
    expect((await send('PUT', `/context/packs/${pack.id}`, edit, EA_AUTH)).status).toBe(403)
    expect((await send('DELETE', `/context/packs/${pack.id}`)).status).toBe(403)
    expect((await guidePack()).body).toBe(pack.body)
  })

  it('puts the guide after the workspace line of a new agent, and only the line once unlinked', async () => {
    const task = await newTask()
    expect(await linkedNames(task.id)).toEqual(['Seti guide'])
    const append = await appendOf(await fresh(task.id))
    const [line, guide] = append.split('\n\n# ')
    expect(line).toBe(workspaceLine(workspaceDir(task.id)))
    expect(`# ${guide ?? ''}`.startsWith(renderGuide({ mode: task.input_mode }).trim())).toBe(true)

    const before = await setupKey(await fresh(task.id))
    expect((await send('PUT', `/tasks/${task.id}/context-packs`, { pack_ids: [] }, EA_AUTH)).status).toBe(200)
    const unlinked = await appendOf(await fresh(task.id))
    expect(unlinked).toContain(workspaceLine(workspaceDir(task.id)))
    expect(unlinked).not.toContain('# Seti guide')
    expect(await setupKey(await fresh(task.id))).not.toBe(before)

    const chosen = await newTask({ context_pack_ids: [] })
    expect(await linkedNames(chosen.id)).toEqual([])
  })

  it('follows the task update mode', async () => {
    const task = await newTask()
    const pack = await guidePack()
    await setInputMode(await fresh(task.id), 'queue')
    expect((await packForTask(pack, task.id)).body).not.toContain('After a push')
    await setInputMode(await fresh(task.id), 'wake')
    expect((await packForTask(pack, task.id)).body).toContain('After a push')
  })

  it('stops linking to new agents when its default is off, and audits it', async () => {
    const pack = await guidePack()
    const off = await send<ContextPack>('PUT', `/context/packs/${pack.id}/default`, { linked_by_default: false })
    expect(off.data.linked_by_default).toBe(false)
    expect(await linkedNames((await newTask()).id)).toEqual([])

    await send('PUT', `/context/packs/${pack.id}/default`, { linked_by_default: true })
    expect(await linkedNames((await newTask()).id)).toEqual(['Seti guide'])
    const audit = await send<AuditPage>('GET', '/audit?kind=context.pack_default_changed&limit=5')
    expect(audit.data.events.map((event) => event.summary)).toEqual([
      'Linked context pack "Seti guide" by default for agents without their own choice',
      'Unlinked context pack "Seti guide" by default for agents without their own choice',
    ])
  })

  it('shows in the workspace as a read-only pack file whose linked line still works', async () => {
    const task = await newTask()
    await openWorkspace(task.id)
    const file = path.join(workspaceDir(task.id), 'packs/seti-guide.md')
    const read = () => fs.readFileSync(file, 'utf8')
    expect(read()).toContain('linked: true')
    expect(read()).toContain(renderGuide({ mode: task.input_mode }).trim())

    fs.writeFileSync(file, read().replace('- Batch independent reads', '- Never batch reads'))
    await vi.waitFor(() => {
      expect(read()).toContain('<!-- seti: rejected: Seti guide is built into Seti')
    })
    expect(read()).toContain('- Batch independent reads')

    fs.writeFileSync(file, read().replace('linked: true', 'linked: false'))
    await vi.waitFor(async () => {
      expect(await linkedNames(task.id)).toEqual([])
    })
  })
})

async function migrateGuide(seed: string) {
  return migrateWith('seti_guide_pack', seed, async (tx) => {
    const packs = await tx`SELECT name, builtin, linked_by_default FROM context_pack ORDER BY name`
    const links = await tx`SELECT task_id, pack_id FROM task_context_pack`
    const legacy = await tx`SELECT to_regclass('agent_guide_settings') AS still`
    return { packs: [...packs], links: links.length, legacy: [...legacy] }
  })
}

const OLD_TASK = `INSERT INTO task (id, title, cwd, status, created_at, updated_at)
  VALUES ('old', 'Old', '/tmp', 'idle', 'x', 'x');
INSERT INTO context_pack (id, name, body, created_at, updated_at) VALUES ('mine', 'Seti guide', 'b', 'x', 'x');`

describe('the pack migration', () => {
  it('keeps the guide on for existing tasks while the setting was on', async () => {
    expect(await migrateGuide(OLD_TASK)).toEqual({
      packs: [
        { name: 'Seti guide', builtin: true, linked_by_default: true },
        { name: 'Seti guide (yours)', builtin: false, linked_by_default: false },
      ],
      links: 1,
      legacy: [{ still: null }],
    })
  })

  it('carries a switched-off setting into the default link', async () => {
    const off = `${OLD_TASK} INSERT INTO agent_guide_settings (id, enabled, updated_at) VALUES (1, false, 'x');`
    expect(await migrateGuide(off)).toMatchObject({
      packs: [{ name: 'Seti guide', builtin: true, linked_by_default: false }, { name: 'Seti guide (yours)' }],
      links: 0,
    })
  })
})
