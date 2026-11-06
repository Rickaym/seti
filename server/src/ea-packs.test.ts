import fs from 'node:fs'
import {
  BUILTIN_ROLES,
  EA_PACK_CHARS_MAX,
  type ContextPack,
  type ContextPackLinks,
  type ContextPackSummary,
  type EaPackPrompt,
} from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { sql, tasks } from './db.js'
import { auditEvents } from './store/audit.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-ea-packs-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const app = createApp()
const LEAD = BUILTIN_ROLES.find((role) => role.name === 'Lead')
const GUIDE_ID = '5e710000-0000-4000-8000-000000000001'

afterAll(() => {
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

let count = 0

async function newPack(kind: 'reference' | 'role', body: string, name = `${kind} ${String(++count)}`) {
  const reply = await send<ContextPack>('POST', '/context/packs', { name, description: '', body, kind })
  expect(reply.status).toBe(200)
  return reply.data
}

const prompt = async () => (await send<EaPackPrompt>('GET', '/ea/context-packs/prompt')).data
const linked = async () => (await send<ContextPackSummary[]>('GET', '/ea/context-packs')).data
const link = async (ids: string[], auth = USER_AUTH) =>
  send<ContextPackSummary[]>('PUT', '/ea/context-packs', { pack_ids: ids }, auth)
const setRole = async (id: string | null, auth = USER_AUTH) =>
  send<ContextPackSummary[]>('PUT', '/ea/role', { pack_id: id }, auth)

beforeEach(async () => {
  await sql`DELETE FROM ea_context_pack`
})

describe('EA context packs', () => {
  it('links nothing by default, even packs linked to every agent by default', async () => {
    const pack = await newPack('reference', 'Ship on Fridays.')
    expect((await send('PUT', `/context/packs/${pack.id}/default`, { linked_by_default: true })).status).toBe(200)
    expect(await linked()).toEqual([])
    expect(await prompt()).toEqual({
      text: '',
      chars: 0,
      max_chars: EA_PACK_CHARS_MAX,
      mod_actions: '',
      form_of_address: '',
    })
  })

  it('puts the role first, then the reference packs by name', async () => {
    const zebra = await newPack('reference', 'Zebra facts.', 'Zebra')
    const alpha = await newPack('reference', 'Alpha facts.', 'Alpha')
    const role = await newPack('role', 'Chief of staff: you plan the week.', 'Chief of staff')
    expect((await link([zebra.id, role.id, alpha.id])).status).toBe(200)
    expect((await linked()).map((pack) => pack.name)).toEqual(['Chief of staff', 'Alpha', 'Zebra'])
    const { text } = await prompt()
    expect(text).toBe(
      [
        '## Your role\nThe user gave you this standing role; it holds on every turn.\n\nChief of staff: you plan the week.',
        'The user attached these context packs to you. Treat them as reference material.',
        '## Context pack: Alpha\n\nAlpha facts.',
        '## Context pack: Zebra\n\nZebra facts.',
      ].join('\n\n'),
    )
  })

  it('reads packs fresh, so an edit or a delete shows in the next prompt', async () => {
    const pack = await newPack('reference', 'First draft.', 'Drafts')
    await link([pack.id])
    expect((await prompt()).text).toContain('First draft.')
    await send('PUT', `/context/packs/${pack.id}`, { name: 'Drafts', description: '', body: 'Second draft.' })
    expect((await prompt()).text).toContain('Second draft.')
    expect((await prompt()).text).not.toContain('First draft.')
    expect((await send('DELETE', `/context/packs/${pack.id}`)).status).toBe(204)
    expect(await linked()).toEqual([])
  })

  it('renders a built-in role from Seti code', async () => {
    expect((await setRole(LEAD?.id ?? '')).status).toBe(200)
    expect((await prompt()).text).toContain(LEAD?.text ?? 'missing')
  })

  it('cuts the text at the cap and still reports the full length', async () => {
    const long = await newPack('reference', 'word '.repeat(2_000).trim(), 'Long')
    await link([long.id])
    const result = await prompt()
    expect(result.chars).toBeGreaterThan(EA_PACK_CHARS_MAX)
    expect(result.text.length).toBeLessThanOrEqual(EA_PACK_CHARS_MAX)
    expect(result.text.endsWith('[The linked context packs run on past this point; Seti cut them to fit.]')).toBe(true)
    expect(result.text.startsWith('The user attached these context packs to you.')).toBe(true)
  })

  it('takes at most one role', async () => {
    const one = await newPack('role', 'One.')
    const two = await newPack('role', 'Two.')
    const reference = await newPack('reference', 'Ref.')
    const both = await link([one.id, two.id])
    expect(both.status).toBe(400)
    expect(await linked()).toEqual([])
    await link([one.id, reference.id])
    expect((await setRole(two.id)).data.map((pack) => pack.id)).toEqual([two.id, reference.id])
    expect((await setRole(reference.id)).status).toBe(400)
    await expect(
      sql`INSERT INTO ea_context_pack (pack_id, role, linked_at) VALUES (${one.id}, true, 'x')`,
    ).rejects.toThrow(/ea_context_pack_one_role/)
    expect((await setRole(null)).data.map((pack) => pack.id)).toEqual([reference.id])
  })

  it('refuses the Seti guide, which is written for agents', async () => {
    const res = await app.request('/api/ea/context-packs', {
      method: 'PUT',
      headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ pack_ids: [GUIDE_ID] }),
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Seti guide is written for agents; the EA has a prompt of its own')
    expect(await linked()).toEqual([])
  })

  it('audits each change once, with the EA named when it made it', async () => {
    const reference = await newPack('reference', 'Ref.', 'Audited ref')
    const role = await newPack('role', 'Role.', 'Audited role')
    await link([reference.id])
    expect(await auditEvents.latest('ea.context_packs_changed')).toMatchObject({
      actor: 'user',
      subject_type: 'ea',
      summary: 'Context packs of the EA: Audited ref',
      detail: { pack_kind: 'reference', before: [], after: ['Audited ref'] },
    })
    const before = (await auditEvents.latest('ea.context_packs_changed'))?.id
    await link([reference.id])
    expect((await auditEvents.latest('ea.context_packs_changed'))?.id).toBe(before)
    await setRole(role.id, EA_AUTH)
    expect(await auditEvents.latest('ea.context_packs_changed')).toMatchObject({
      actor: 'user',
      summary: 'Role of the EA: Audited role',
      detail: { pack_kind: 'role', before: [], after: ['Audited role'], via: 'ea' },
    })
  })

  it("names the EA among a pack's links, beside the agents that read it", async () => {
    const pack = await newPack('reference', 'Shared.', 'Shared')
    const id = `ea-packs-task-${String(++count)}`
    await tasks.insert({
      id,
      title: 'Linker',
      repo_id: null,
      cwd: scratch,
      worktree: false,
      sandbox: false,
      pr_urls: [],
    })
    await send('PUT', `/tasks/${id}/context-packs`, { pack_ids: [pack.id] })
    const before = (await send<ContextPackLinks>('GET', `/context/packs/${pack.id}/links`)).data
    expect(before).toEqual({ agents: [{ id, title: 'Linker' }], ea: false })
    await link([pack.id])
    expect((await send<ContextPackLinks>('GET', `/context/packs/${pack.id}/links`)).data.ea).toBe(true)
  })
})
