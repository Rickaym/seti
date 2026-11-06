import fs from 'node:fs'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import {
  BUILTIN_ROLES,
  roleLabel,
  type AccessDefault,
  type AuditPage,
  type ContextPack,
  type ContextPackSummary,
  type Task,
} from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { removeTaskFiles } from './archive-files.js'
import { tasks } from './db.js'
import { sessionOptions, setupKey } from './session-options.js'
import { renderGuide, workspaceLine } from './seti-guide.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { workspaceDir } from './workspace/dir.js'
import { openWorkspace } from './workspace/engine.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-role-packs-test-'))
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

const app = createApp()
const made: string[] = []

afterAll(async () => {
  for (const id of made) {
    const task = await tasks.get(id)
    if (task) {
      await removeTaskFiles(task)
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

interface Reply<T> {
  status: number
  data: T
}

async function send<T = unknown>(method: string, url: string, body?: unknown, auth = USER_AUTH): Promise<Reply<T>> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, data: (text === '' ? null : (JSON.parse(text) as { data: T }).data) as T }
}

const newTask = async (title: string) => {
  const task = (await send<Task>('POST', '/tasks', { title, prompt: 'Hi', cwd: scratch })).data
  made.push(task.id)
  return task
}

const fresh = async (id: string) => {
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('no task')
  }
  return task
}

async function appendOf(id: string): Promise<string> {
  const { systemPrompt } = await sessionOptions(await fresh(id), new AbortController())
  if (typeof systemPrompt !== 'object' || Array.isArray(systemPrompt) || systemPrompt.type !== 'preset') {
    throw new Error('no preset system prompt')
  }
  return systemPrompt.append ?? ''
}

const [LEAD, REVIEWER] = BUILTIN_ROLES.map((role) => role.id)

const newPack = async (name: string, body: string, kind: 'role' | 'reference' = 'role') =>
  (await send<ContextPack>('POST', '/context/packs', { name, description: '', body, kind })).data

const setRole = async (taskId: string, packId: string | null, auth = USER_AUTH) =>
  send<ContextPackSummary[]>('PUT', `/tasks/${taskId}/role`, { pack_id: packId }, auth)

const roleOf = async (taskId: string) =>
  (await send<ContextPackSummary[]>('GET', `/tasks/${taskId}/context-packs`)).data
    .filter((pack) => pack.kind === 'role')
    .map((pack) => pack.name)

const roleEvents = async () =>
  (await send<AuditPage>('GET', '/audit?kind=task.context_packs_changed&limit=50')).data.events
    .filter((event) => event.detail.pack_kind === 'role')
    .toReversed()

describe('built-in role packs', () => {
  it('are read-only role packs with their text from Seti, never linked by default', async () => {
    const packs = (await send<ContextPack[]>('GET', '/context/packs')).data
    const roles = packs.filter((pack) => pack.kind === 'role' && pack.builtin)
    expect(roles.map((pack) => pack.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'Lead',
      'Reviewer',
      'Watcher',
    ])
    for (const role of BUILTIN_ROLES) {
      expect(packs.find((pack) => pack.id === role.id)).toMatchObject({
        body: role.text,
        linked_by_default: false,
      })
    }
    expect(packs.find((pack) => pack.name === 'Seti guide')?.kind).toBe('reference')

    const edit = { name: 'Lead', description: '', body: 'Do it all yourself.' }
    expect((await send('PUT', `/context/packs/${LEAD ?? ''}`, edit)).status).toBe(403)
    expect((await send('DELETE', `/context/packs/${LEAD ?? ''}`)).status).toBe(403)
    const byDefault = await send('PUT', `/context/packs/${LEAD ?? ''}/default`, { linked_by_default: true })
    expect(byDefault.status).toBe(400)
    const own = await newPack('Default role', 'x')
    expect((await send('PUT', `/context/packs/${own.id}/default`, { linked_by_default: true })).status).toBe(400)
  })

  it('duplicate into editable copies, and the guide does not', async () => {
    const copy = (await send<ContextPack>('POST', `/context/packs/${LEAD ?? ''}/duplicate`)).data
    expect(copy).toMatchObject({ name: 'Lead (copy)', kind: 'role', builtin: false })
    expect(copy.body).toBe(BUILTIN_ROLES[0]?.text)
    const second = (await send<ContextPack>('POST', `/context/packs/${LEAD ?? ''}/duplicate`)).data
    expect(second.name).toBe('Lead (copy 2)')
    const edited = { name: 'Lead (copy)', description: '', body: 'Lead, and write the docs.' }
    expect((await send('PUT', `/context/packs/${copy.id}`, edited)).status).toBe(200)
    const guide = (await send<ContextPack[]>('GET', '/context/packs')).data.find((pack) => pack.name === 'Seti guide')
    expect((await send('POST', `/context/packs/${guide?.id ?? ''}/duplicate`)).status).toBe(400)
  })

  it('are terse plain ASCII, each with a first line naming it', () => {
    for (const role of BUILTIN_ROLES) {
      expect(role.text).toMatch(/^[\x20-\x7e\n]*$/)
      expect(role.text.length).toBeLessThan(700)
      expect(role.text.startsWith(`${role.name}: `)).toBe(true)
      expect(roleLabel(role.name, role.text, 1000)).toBe(role.text.split('\n')[0])
      for (const line of role.text.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(100)
      }
    }
    const lead = BUILTIN_ROLES[0]?.text ?? ''
    expect(lead).toContain('run_in_background: true')
    expect(lead).toContain('@ea')
  })
})

describe("an agent's role pack", () => {
  it('is one at most: linking another replaces it, null removes it, and reference packs are refused', async () => {
    const task = await newTask('Role basics')
    expect(await roleOf(task.id)).toEqual([])
    expect((await setRole(task.id, LEAD ?? null)).status).toBe(200)
    expect(await roleOf(task.id)).toEqual(['Lead'])
    expect((await setRole(task.id, REVIEWER ?? null)).data.filter((pack) => pack.kind === 'role')).toEqual([
      { id: REVIEWER, name: 'Reviewer', kind: 'role' },
    ])
    const reference = await newPack('Role basics notes', 'notes', 'reference')
    expect((await setRole(task.id, reference.id)).status).toBe(400)
    expect((await setRole(task.id, '44444444-4444-4444-8444-444444444444')).status).toBe(404)

    const linked = (await send<ContextPackSummary[]>('GET', `/tasks/${task.id}/context-packs`)).data.map((p) => p.id)
    const twoRoles = await send('PUT', `/tasks/${task.id}/context-packs`, { pack_ids: [...linked, LEAD] })
    expect(twoRoles.status).toBe(400)
    expect(await roleOf(task.id)).toEqual(['Reviewer'])

    expect((await setRole(task.id, null)).status).toBe(200)
    expect(await roleOf(task.id)).toEqual([])
  })

  it('is audited as a pack link of kind role, without the text, and skips a no-op', async () => {
    const task = await newTask('Role audit')
    const own = await newPack('Role audit role', 'Review every PR.')
    const before = (await roleEvents()).length
    await setRole(task.id, own.id)
    await setRole(task.id, own.id)
    await setRole(task.id, LEAD ?? null)
    await setRole(task.id, null, EA_AUTH)
    const events = (await roleEvents()).slice(before)
    expect(events.map((event) => event.summary)).toEqual([
      'Role of "Role audit": Role audit role',
      'Role of "Role audit": Lead',
      'Role of "Role audit": none',
    ])
    expect(events[1]?.detail).toMatchObject({ before: ['Role audit role'], after: ['Lead'], pack_kind: 'role' })
    expect(events[2]?.detail).toMatchObject({ before: ['Lead'], after: [], via: 'ea' })
    expect(JSON.stringify(events)).not.toContain('Review every PR')
  })

  it('stays out of the access lists, which keep the reference packs', async () => {
    const task = await newTask('Role access')
    const catalog = (await send<AccessDefault[]>('GET', '/access')).data
    expect(catalog.some((item) => item.kind === 'pack' && item.name === 'Seti guide')).toBe(true)
    expect(catalog.some((item) => item.kind === 'pack' && item.id === LEAD)).toBe(false)
    const turnOn = await send('PUT', `/tasks/${task.id}/access`, { kind: 'pack', id: LEAD, enabled: true })
    expect(turnOn.status).toBe(404)
  })

  it('stands after the guide and before reference packs, and restarts the session when it changes', async () => {
    const task = await newTask('Role prompt')
    const notes = await newPack('Role prompt notes', 'Ship on Fridays.', 'reference')
    const linked = (await send<ContextPackSummary[]>('GET', `/tasks/${task.id}/context-packs`)).data.map((p) => p.id)
    await send('PUT', `/tasks/${task.id}/context-packs`, { pack_ids: [...linked, notes.id] })
    expect(await appendOf(task.id)).not.toContain('## Your role')
    const key = await setupKey(await fresh(task.id))

    const own = await newPack('Role prompt role', 'Release lead: delegate the work.')
    await setRole(task.id, own.id)
    const append = await appendOf(task.id)
    const at = (text: string) => append.indexOf(text)
    expect(at(workspaceLine(workspaceDir(task.id)))).toBe(0)
    expect(at(renderGuide({ mode: task.input_mode }).trim())).toBeGreaterThan(0)
    expect(append).toContain(
      '## Your role\nThe user gave you this standing role; it holds on every turn.\n\nRelease lead: delegate the work.',
    )
    expect(at('## Your role\n')).toBeGreaterThan(at('# Seti guide'))
    expect(at('## Context pack: Role prompt notes')).toBeGreaterThan(at('Release lead: delegate the work.'))
    expect(append).not.toContain('## Context pack: Role prompt role')
    const withRole = await setupKey(await fresh(task.id))
    expect(withRole).not.toBe(key)

    await send('PUT', `/context/packs/${own.id}`, { name: own.name, description: '', body: 'Watch CI.' })
    expect(await appendOf(task.id)).toContain('holds on every turn.\n\nWatch CI.')
    expect(await setupKey(await fresh(task.id))).not.toBe(withRole)
    await setRole(task.id, LEAD ?? null)
    expect(await appendOf(task.id)).toContain(`holds on every turn.\n\n${BUILTIN_ROLES[0]?.text ?? ''}`)
  })

  it('shows in members.md by name and first line and in its own task.md', async () => {
    const task = await newTask('Release lead')
    const peer = await newTask('Role peer')
    await openWorkspace(peer.id)
    await openWorkspace(task.id)
    const read = (id: string, rel: string) => fs.readFileSync(path.join(workspaceDir(id), rel), 'utf8')
    expect(read(task.id, 'task.md')).toContain('## Role\n')
    expect(read(task.id, 'task.md')).toMatch(/## Role\n\n.*\n.*\n\n- none\n/)

    const body = `# Lead the release | train ${'x'.repeat(120)}\n- Delegate implementation.`
    const own = await newPack('Train lead', body)
    await setRole(task.id, own.id)
    await vi.waitFor(() => {
      expect(read(task.id, 'task.md')).toContain('\n- Train lead: packs/train-lead.md\n')
    })
    const label = roleLabel('Train lead', body, 80)
    expect(label.startsWith('Train lead: Lead the release')).toBe(true)
    expect(label.endsWith('...')).toBe(true)
    await vi.waitFor(() => {
      expect(read(peer.id, 'members.md')).toContain(`| Release lead | ${label.replace('|', '\\|')} |`)
    })
    expect(read(peer.id, 'members.md')).toContain('| Role peer | - |')
    expect(read(peer.id, 'members.md')).toContain('| Agent | Status | Muted | Task | Role | Working on |')
    expect(read(peer.id, 'members.md')).not.toContain('Delegate implementation')

    await setRole(task.id, LEAD ?? null)
    await vi.waitFor(() => {
      expect(read(peer.id, 'members.md')).toContain(
        '| Release lead | Lead: you run a stream of work and delegate it; you are not its implementer. |',
      )
    })
  })
})
