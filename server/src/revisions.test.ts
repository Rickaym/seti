import fs from 'node:fs'
import path from 'node:path'
import type { AuditPage, ContextFileContent, ContextPack, Revision, UnseenChange } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { requirePack, updatePack } from './context-changes.js'
import { tasks } from './db.js'
import { byAgent } from './revisions.js'
import { USER_AUTH } from './test-auth.js'
import { addNote } from './workspace/notes.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-revisions-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

vi.mock('./runner.js', () => ({
  runTurn: () => undefined,
  stopTurn: async () => Promise.resolve(),
  endSession: async () => Promise.resolve(),
  isRunning: () => false,
  registerContextProvider: () => undefined,
  registerSessionMcpServers: () => undefined,
  registerTurnPreface: () => undefined,
  onTurnEnd: () => undefined,
  subscribe: () => () => undefined,
}))

const app = createApp()
const TASK = 'feedback-task'
await tasks.insert({ id: TASK, title: 'Feedback', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
async function send<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  const parsed = text === '' ? null : (JSON.parse(text) as { data?: T; error?: { detail: string } })
  return { status: res.status, data: (parsed?.data ?? parsed?.error?.detail ?? null) as T }
}

async function historyOf(objectType: string, objectId: string): Promise<Revision[]> {
  const res = await send<Revision[]>(
    'GET',
    `/revisions?object_type=${objectType}&object_id=${encodeURIComponent(objectId)}`,
  )
  expect(res.status).toBe(200)
  return res.data
}

/** Changes a pack's body as an agent editing its workspace file would. */
async function agentBody(id: string, body: string, reason: string): Promise<void> {
  const { name, description } = await requirePack(id)
  expect((await updatePack(id, { name, description, body }, byAgent(TASK, reason))).revision).not.toBeNull()
}

const newPack = async (name: string) =>
  (await send<ContextPack>('POST', '/context/packs', { name, body: 'Line one\nLine two' })).data.id

describe('revisions from UI routes', () => {
  it('records pack create and edits by the user, skipping saves that change nothing', async () => {
    const id = await newPack('Nightly')
    await send('PUT', `/context/packs/${id}`, { name: 'Nightly', body: 'Line one\nLine 2' })
    await send('PUT', `/context/packs/${id}`, { name: 'Nightly', body: 'Line one\nLine 2' })
    const list = await historyOf('context_pack', id)
    expect(list.map((r) => [r.kind, r.actor, r.task_id])).toEqual([
      ['updated', 'user', null],
      ['created', 'user', null],
    ])
    expect(list[0]?.before).toMatchObject({ name: 'Nightly', body: 'Line one\nLine two' })
    expect(list[0]?.after).toMatchObject({ body: 'Line one\nLine 2' })
  })

  it('records pack and CLAUDE.md saves', async () => {
    const pack = await send<ContextPack>('POST', '/context/packs', { name: 'Ops', body: 'v1' })
    await send('PUT', `/context/packs/${pack.data.id}`, { name: 'Ops', body: 'v2' })
    expect((await historyOf('context_pack', pack.data.id)).map((r) => r.after?.body)).toEqual(['v2', 'v1'])

    await send('PUT', '/context/files/user', { content: 'one', base_hash: null })
    const file = await send<ContextFileContent>('GET', '/context/files/user')
    await send('PUT', '/context/files/user', { content: 'two', base_hash: file.data.hash })
    const fileHistory = await historyOf('context_file', 'user')
    expect(fileHistory.map((r) => [r.kind, r.before?.content ?? null, r.after?.content])).toEqual([
      ['updated', 'one\n', 'two\n'],
      ['created', null, 'one\n'],
    ])
  })

  it('validates the query', async () => {
    expect((await send('GET', '/revisions?object_type=task&object_id=x')).status).toBe(400)
    expect((await send('GET', '/revisions?object_type=context_pack')).status).toBe(400)
  })
})

describe('revert', () => {
  it('restores only the fields the revision changed and records a user revision', async () => {
    const id = await newPack('Revert me')
    await agentBody(id, 'Agent body', 'User feedback')
    const edit = { name: 'Revert me', description: 'Kept', body: 'Agent body' }
    await send('PUT', `/context/packs/${id}`, edit)
    const agentRevision = (await historyOf('context_pack', id)).find((r) => r.actor === 'agent')

    const reverted = await send<Revision>('POST', `/revisions/${String(agentRevision?.id)}/revert`, {})
    expect(reverted.status).toBe(200)
    expect(reverted.data).toMatchObject({ actor: 'user', reason: `Reverted revision #${String(agentRevision?.id)}` })
    expect(await requirePack(id)).toMatchObject({ body: 'Line one\nLine two', description: 'Kept' })

    const again = await send<string>('POST', `/revisions/${String(agentRevision?.id)}/revert`, {})
    expect(again).toEqual({ status: 409, data: 'Nothing to revert: the object already has the earlier values' })

    const audit = await send<AuditPage>('GET', '/audit?kind=context.pack_updated&limit=1')
    expect(audit.data.events[0]?.detail).toMatchObject({ reason: `Reverted revision #${String(agentRevision?.id)}` })
  })

  it('restores a pack and a CLAUDE.md file', async () => {
    const pack = await send<ContextPack>('POST', '/context/packs', { name: 'Style', body: 'Be brief.' })
    await send('PUT', `/context/packs/${pack.data.id}`, { name: 'Style', body: 'Be verbose.' })
    const [change] = await historyOf('context_pack', pack.data.id)
    await send('POST', `/revisions/${String(change?.id)}/revert`, {})
    expect((await send<ContextPack>('GET', `/context/packs/${pack.data.id}`)).data.body).toBe('Be brief.')

    const [fileChange] = await historyOf('context_file', 'user')
    await send('POST', `/revisions/${String(fileChange?.id)}/revert`, {})
    expect(fs.readFileSync(path.join(scratch, 'claude', 'CLAUDE.md'), 'utf8')).toBe('one\n')
  })

  it('refuses creations, notes, unknown ids and bad bodies', async () => {
    const id = await newPack('Created')
    const [created] = await historyOf('context_pack', id)
    expect((await send('POST', `/revisions/${String(created?.id)}/revert`, {})).status).toBe(400)
    await addNote(TASK, { object_type: 'context_pack', object_id: id }, 'context pack', 'noted')
    const [note] = await historyOf('context_pack', id)
    expect(note?.kind).toBe('note')
    expect((await send('POST', `/revisions/${String(note?.id)}/revert`, {})).status).toBe(400)
    expect((await send('POST', '/revisions/999999/revert', {})).status).toBe(404)
    expect((await send('POST', '/revisions/abc/revert', {})).status).toBe(400)
    expect((await send('POST', `/revisions/${String(created?.id)}/revert`, { force: true })).status).toBe(400)
  })
})

describe('unseen agent changes', () => {
  it('lists objects whose latest change came from an agent until the user marks them seen', async () => {
    const id = await newPack('Watched')
    const unseen = async () => (await send<UnseenChange[]>('GET', '/revisions/unseen')).data.map((c) => c.object_id)
    expect(await unseen()).not.toContain(id)

    await agentBody(id, 'Changed by agent', 'feedback')
    expect(await unseen()).toContain(id)
    await addNote(TASK, { object_type: 'context_pack', object_id: id }, 'context pack', 'why')
    expect(await unseen()).toContain(id)

    expect((await send('POST', '/revisions/seen', { object_type: 'context_pack', object_id: id })).status).toBe(200)
    expect(await unseen()).not.toContain(id)

    await agentBody(id, 'Changed again', 'more feedback')
    expect(await unseen()).toContain(id)
    await send('PUT', `/context/packs/${id}`, { name: 'Watched', body: 'User wins' })
    expect(await unseen()).not.toContain(id)
    expect((await send('POST', '/revisions/seen', { object_type: 'nope', object_id: id })).status).toBe(400)
  })
})
