import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MOD_OP_NAMES, MOD_OPS, modScoped, type MessageRow, type Task } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { asAgent, asMod } from '../../access.js'
import { messages, sql, tasks } from '../../db.js'
import { DIRECT_HIDDEN } from '../../direct-privacy.js'
import { contextPacks, taskContextPacks } from '../../store/context.js'
import { ensureMember, postTeamMessage } from '../../team.js'
import { waitIdle } from '../../wait-idle.js'
import { modAuditKinds, notifyKinds } from '../points.js'
import { modStatusItems } from './basics.js'
import { contextForConsent, modContextPrompt, registerModContext } from './context.js'
import { dispatchModOp, EventCounters } from '../logic/dispatch.js'
import { grantedFrom } from '../scopes.js'
import { callModOp, logicOps, runModOp } from './table.js'
import { callAs, probeManifest, valueOf } from './test-probe.js'

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('../../fake-sdk.js')
  return new FakeSdk(function* () {
    yield fakeResult()
  })
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-mod-ops-'))
const cwd = path.join(scratch, 'agent')
const outside = path.join(scratch, 'outside')

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const write = (file: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

async function agent(id: string, title: string): Promise<{ task: Task; handle: string }> {
  await tasks.insert({ id, title, repo_id: null, cwd, worktree: false, pr_urls: [], seti_control: 'full' })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error(`${id} was not stored`)
  }
  return { task, handle: (await ensureMember(task)).handle }
}

const denied = (message: string) => ({ ok: false, error: { code: 'denied', message } })

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const GH_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`

const builder = await agent('mod-ops-builder', 'Builder')
const other = await agent('mod-ops-other', 'Other')
const reviewer = await agent('mod-ops-reviewer', 'Reviewer agent')

beforeAll(async () => {
  write(path.join(cwd, 'notes', 'plan.md'), `# Plan\naws_access_key_id = ${AWS_KEY}\n`)
  write(path.join(cwd, 'notes', 'deep', 'more.md'), '# More\n')
  write(path.join(cwd, 'notes', 'big.md'), 'x'.repeat(600 * 1024))
  write(path.join(cwd, 'notes', 'blob.md'), Buffer.from([0, 1, 2, 3, 255, 0]))
  write(path.join(cwd, 'notes', 'id_rsa'), 'not really a key\n')
  write(path.join(cwd, 'notes', 'credentials.json'), '{}\n')
  write(path.join(cwd, '.env'), 'TOKEN=abcdefghijk\n')
  write(path.join(cwd, 'config', '.env.local'), 'TOKEN=abcdefghijk\n')
  write(path.join(cwd, '.git', 'config'), '[core]\n')
  write(path.join(cwd, 'src', 'main.ts'), 'export {}\n')
  write(path.join(outside, '.ssh', 'id_ed25519'), 'PRIVATE\n')
  fs.symlinkSync(path.join(outside, '.ssh', 'id_ed25519'), path.join(cwd, 'notes', 'ssh.md'))
  fs.symlinkSync(path.join(cwd, 'src', 'main.ts'), path.join(cwd, 'notes', 'main.md'))
  const role = (await contextPacks.list()).find((pack) => pack.name === 'Reviewer' && pack.kind === 'role')
  await taskContextPacks.setRole(reviewer.task.id, role?.id ?? expect.fail('no Reviewer role'))
})

describe('the op table', () => {
  it('names every op the table runs, and nothing else', async () => {
    expect(MOD_OP_NAMES).toMatchInlineSnapshot(`
      [
        "settings.get",
        "audit.record",
        "status.set",
        "storage.get",
        "storage.keys",
        "storage.set",
        "storage.delete",
        "notify.send",
        "net.fetch",
        "connection.fetch",
        "tasks.list",
        "tasks.get",
        "tasks.transcript",
        "tasks.prs",
        "tasks.manage.rename",
        "tasks.manage.pin",
        "tasks.manage.set_color",
        "tasks.manage.link_pr",
        "tasks.manage.unlink_pr",
        "tasks.manage.start",
        "tasks.manage.stop",
        "chat.post",
        "chat.post.direct",
        "files.list",
        "files.read",
      ]
    `)
    const bare = probeManifest()
    for (const op of ['secrets.get', 'connections.list', '__proto__', 'constructor', 'toString']) {
      expect(await callAs(bare, op, {})).toEqual({
        ok: false,
        error: { code: 'invalid', message: `${op} is not an op a mod can call` },
      })
    }
  })

  it('lists in docs/security.md exactly the ops the table runs', () => {
    const doc = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../docs/security.md'), 'utf8')
    const section = doc.split('### Operations')[1]?.split('\n### ')[0] ?? ''
    const documented = [...section.matchAll(/^\| `([a-z._]+)` +\|/gm)].map((match) => match[1])
    expect(documented).toEqual(MOD_OP_NAMES)
  })

  it('answers only a mod', async () => {
    await expect(runModOp('storage.get', { key: 'k' }, probeManifest())).rejects.toThrow('answers only a mod')
    await expect(
      asAgent(builder.task, async () => runModOp('storage.get', { key: 'k' }, probeManifest())),
    ).rejects.toThrow('answers only a mod')
  })

  it('refuses each op without its capability, and audits refusals up to a cap', async () => {
    const bare = probeManifest([], {}, 'bare')
    const needs = MOD_OP_NAMES.filter((op) => MOD_OPS[op] !== null)
    for (const op of needs) {
      expect(await callAs(bare, op, {}), op).toEqual(denied(`The mod bare was not granted ${String(MOD_OPS[op])}`))
    }
    const [row] = await sql<{ count: string; actors: string[] }[]>`SELECT count(*) AS count,
        array_agg(DISTINCT actor) AS actors FROM audit_event WHERE kind = 'mod.call_refused' AND subject_id = 'bare'`
    expect(needs.length).toBeGreaterThan(20)
    expect(Number(row?.count)).toBe(20)
    expect(row?.actors).toEqual(['mod:bare'])
  })

  it('refuses a manifest that is not the calling mod', async () => {
    const result = await asMod({ id: 'one', grants: [] }, async () => callModOp('settings.get', {}, probeManifest()))
    expect(result).toEqual(denied('The manifest of probe does not belong to the mod one'))
  })
})

describe('the logic dispatcher', () => {
  it('runs the same ops for mod logic, only while the mod has a running manifest', async () => {
    const manifest = probeManifest([{ name: 'storage' }], {}, 'logic')
    const { grants, scopes } = grantedFrom([{ capability: { name: 'storage' }, connection_id: null }])
    const run = { modId: 'logic', grants, scopes, eventId: 'logic-1', caller: 'schedule' as const }
    const deps = (found: typeof manifest | null) => ({
      ops: logicOps(async () => Promise.resolve(found)),
      denied: async () => Promise.resolve(),
    })
    const event = () => ({ run, counters: new EventCounters() })
    expect(await dispatchModOp(deps(manifest), event(), 'storage.set', { key: 'k', value: 2 })).toEqual({
      ok: true,
      value: null,
    })
    expect(await dispatchModOp(deps(manifest), event(), 'storage.get', { key: 'k' })).toEqual({ ok: true, value: 2 })
    expect(await dispatchModOp(deps(null), event(), 'storage.get', { key: 'k' })).toEqual({
      ok: false,
      error: { code: 'denied', message: 'logic is not installed and on' },
    })
  })
})

describe('storage', () => {
  const store = probeManifest([{ name: 'storage' }])
  const neighbour = probeManifest([{ name: 'storage' }], {}, 'neighbour')

  it('keeps each mod to its own keys, named by the call and never by args', async () => {
    valueOf(await callAs(store, 'storage.set', { key: 'k', value: { a: 1 } }))
    expect(valueOf(await callAs(store, 'storage.get', { key: 'k' }))).toEqual({ a: 1 })
    expect(valueOf(await callAs(neighbour, 'storage.get', { key: 'k' }))).toBeNull()
    expect(await callAs(neighbour, 'storage.get', { key: 'k', modId: 'probe' })).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    })
    const proto = JSON.parse('{"key":"k","__proto__":{"modId":"probe"}}') as unknown
    expect(await callAs(neighbour, 'storage.get', proto)).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(valueOf(await callAs(neighbour, 'storage.keys', {}))).toEqual([])
  })

  it('refuses values and keys past the caps', async () => {
    const tooLarge = await callAs(store, 'storage.set', { key: 'big', value: 'x'.repeat(64 * 1024) })
    expect(tooLarge).toEqual({ ok: false, error: { code: 'limit', message: 'A stored value is at most 64 KB' } })
    for (let i = 0; i < 16; i++) {
      valueOf(await callAs(store, 'storage.set', { key: `fill-${String(i)}`, value: 'x'.repeat(63 * 1024) }))
    }
    const full = await callAs(store, 'storage.set', { key: 'last', value: 'x'.repeat(63 * 1024) })
    expect(full).toEqual({ ok: false, error: { code: 'limit', message: 'A mod stores at most 1 MB' } })
    const longKey = await callAs(store, 'storage.set', { key: 'k'.repeat(201), value: 1 })
    expect(longKey).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(await callAs(store, 'storage.set', { key: 'none' })).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(valueOf(await callAs(store, 'storage.keys', { prefix: 'fill-1' }))).toEqual([
      'fill-1',
      'fill-10',
      'fill-11',
      'fill-12',
      'fill-13',
      'fill-14',
      'fill-15',
    ])
  })
})

describe('tasks.read', () => {
  const reader = probeManifest([{ name: 'tasks.read', agents: [builder.handle, 'role:reviewer'] }])

  it('lists and reads only the agents in its filter, answering others as missing', async () => {
    const listed = valueOf(await callAs(reader, 'tasks.list', {})) as { id: string }[]
    const byId = (a: string, b: string) => a.localeCompare(b)
    expect(listed.map((entry) => entry.id).sort(byId)).toEqual([builder.task.id, reviewer.task.id].sort(byId))
    const missing = await callAs(reader, 'tasks.get', { id: 'no-such-agent' })
    expect(missing).toEqual({ ok: false, error: { code: 'failed', message: 'Task not found' } })
    expect(await callAs(reader, 'tasks.get', { id: other.task.id })).toEqual(missing)
    expect(await callAs(reader, 'tasks.transcript', { id: other.task.id })).toEqual(missing)
    expect(await callAs(reader, 'tasks.prs', { id: other.task.id })).toEqual(missing)
    expect(valueOf(await callAs(reader, 'tasks.get', { id: builder.task.id }))).toMatchObject({
      id: builder.task.id,
      handle: builder.handle,
    })
  })

  it("hides direct messages but the mod's own, and redacts credentials", async () => {
    const chat = probeManifest([{ name: 'tasks.read' }, { name: 'chat.post', public: true, direct: true }])
    await postTeamMessage({ kind: 'task', taskId: other.task.id }, 'the vault slot is nine', { to: builder.handle })
    valueOf(await callAs(chat, 'chat.post.direct', { text: 'a note from the probe', to: builder.handle }))
    await postTeamMessage({ kind: 'user' }, `@${builder.handle} use ${GH_TOKEN} for this`)
    await waitIdle(builder.task.id)
    const page = valueOf(await callAs(chat, 'tasks.transcript', { id: builder.task.id })) as {
      messages: MessageRow[]
    }
    const text = JSON.stringify(page.messages)
    expect(text).not.toContain('the vault slot is nine')
    expect(text).toContain(DIRECT_HIDDEN)
    expect(text).toContain('a note from the probe')
    expect(text).not.toContain(GH_TOKEN)
    expect((await messages.page(builder.task.id, 50)).messages.length).toBeGreaterThan(0)
  })
})

describe('files.read', () => {
  const files = probeManifest([{ name: 'files.read', agents: [builder.handle], paths: ['notes/**/*.md'] }])
  const read = async (file: string) => callAs(files, 'files.read', { agentId: builder.task.id, path: file })

  it('reads a granted text file with credentials redacted', async () => {
    const plan = valueOf(await read('notes/plan.md')) as { text: string }
    expect(plan.text).toContain('# Plan')
    expect(plan.text).not.toContain(AWS_KEY)
    expect(valueOf(await read('notes/deep/more.md'))).toMatchObject({ text: '# More\n' })
  })

  it.each([
    ['../outside/.ssh/id_ed25519', 'denied'],
    ['/etc/passwd', 'invalid'],
    ['notes/ssh.md', 'denied'],
    ['notes/main.md', 'denied'],
    ['.env', 'denied'],
    ['config/.env.local', 'denied'],
    ['.git/config', 'denied'],
    ['notes/id_rsa', 'denied'],
    ['notes/credentials.json', 'denied'],
    ['src/main.ts', 'denied'],
    ['notes/blob.md', 'invalid'],
    ['notes/big.md', 'limit'],
  ])('refuses %s', async (file, code) => {
    const result = await read(file)
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { code } })
  })

  it('lists only what the globs reach, and nothing of agents outside the filter', async () => {
    const top = valueOf(await callAs(files, 'files.list', { agentId: builder.task.id })) as {
      entries: { path: string }[]
    }
    expect(top.entries.map((entry) => entry.path)).toEqual(['notes'])
    const notes = valueOf(await callAs(files, 'files.list', { agentId: builder.task.id, dir: 'notes' })) as {
      entries: { path: string }[]
    }
    const listed = notes.entries.map((entry) => entry.path)
    expect(listed).toEqual(expect.arrayContaining(['notes/deep', 'notes/plan.md']))
    expect(listed).not.toContain('notes/id_rsa')
    expect(listed).not.toContain('notes/credentials.json')
    expect(await callAs(files, 'files.list', { agentId: builder.task.id, dir: 'src' })).toEqual(
      denied('src is outside the paths the mod probe was granted'),
    )
    expect(await callAs(files, 'files.read', { agentId: other.task.id, path: 'notes/plan.md' })).toEqual({
      ok: false,
      error: { code: 'failed', message: 'Task not found' },
    })
  })
})

describe('chat.post', () => {
  const publicOnly = probeManifest([{ name: 'chat.post', public: true }], {}, 'poster')
  const both = probeManifest([{ name: 'chat.post', public: true, direct: true }], {}, 'talker')

  it('posts as the mod, labelled as the mod for the agents that read it', async () => {
    for (const handle of [other.handle, 'ea', 'all', 'user']) {
      expect(await callAs(publicOnly, 'chat.post', { text: `@${handle} the build is green` })).toEqual(
        denied(`A mod's public post mentions no one, such as @${handle}; message one agent directly`),
      )
    }
    expect(valueOf(await callAs(publicOnly, 'chat.post', { text: 'The build is green' }))).toHaveProperty('id')
    const teller = probeManifest([{ name: 'chat.post', public: true, direct: true }], {}, 'poster')
    const posted = valueOf(
      await callAs(teller, 'chat.post.direct', { text: 'the build is green', to: other.handle }, { eventId: 'tell' }),
    ) as { id: number }
    const [row] = await sql<{ author_kind: string; author_mod_id: string }[]>`SELECT author_kind, author_mod_id
      FROM team_message WHERE id = ${posted.id}`
    expect(row).toEqual({ author_kind: 'mod', author_mod_id: 'poster' })
    await waitIdle(other.task.id)
    const inputs = (await messages.page(other.task.id, 50)).messages.filter((entry) => entry.kind === 'input')
    expect(JSON.stringify(inputs)).toContain('The poster mod (not the user) sent you a direct message')
    const [audited] = await sql<{ actor: string }[]>`SELECT actor FROM audit_event
      WHERE kind = 'team.direct_posted' AND detail::jsonb->>'message_id' = ${String(posted.id)}`
    expect(audited?.actor).toBe('mod:poster')
  })

  it('refuses direct messages without direct, to the user or the EA, and past the caps', async () => {
    expect(await callAs(publicOnly, 'chat.post.direct', { text: 'hi', to: builder.handle })).toEqual(
      denied('The mod poster was not granted direct messages'),
    )
    expect(await callAs(both, 'chat.post.direct', { text: 'hi', to: 'user' })).toEqual(
      denied('A mod messages one agent directly, never @user'),
    )
    expect(await callAs(both, 'chat.post.direct', { text: 'hi', to: 'ea' })).toEqual(
      denied('A mod messages one agent directly, never @ea'),
    )
    expect(await callAs(both, 'chat.post', { text: 'x'.repeat(4001) })).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    })
    for (let i = 0; i < 3; i++) {
      valueOf(await callAs(both, 'chat.post', { text: `note ${String(i)}` }, { eventId: 'burst' }))
    }
    expect(await callAs(both, 'chat.post', { text: 'one more' }, { eventId: 'burst' })).toEqual({
      ok: false,
      error: { code: 'limit', message: 'talker sent its posts for this event already' },
    })
  })
})

describe('notify and audit', () => {
  const noisy = probeManifest(
    [{ name: 'notify' }],
    { notifications: [{ id: 'digest', title: 'Digest' }], auditKinds: ['summarized'] },
    'noisy',
  )
  notifyKinds.register({ kind: modScoped('noisy', 'digest'), title: 'Digest', mod: 'noisy', default: true })
  notifyKinds.register({ kind: modScoped('neighbour', 'alert'), title: 'Alert', mod: 'neighbour', default: true })
  modAuditKinds.register({ kind: 'mod.noisy.summarized', mod: 'noisy' })

  it('sends only its own declared kinds', async () => {
    expect(
      valueOf(await callAs(noisy, 'notify.send', { kind: 'digest', title: 'Hi', body: '', url: 'javascript:x' })),
    ).toEqual({
      sent: 0,
    })
    expect(await callAs(noisy, 'notify.send', { kind: 'needs_you', title: 'Hi', body: '' })).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    })
    expect(await callAs(noisy, 'notify.send', { kind: 'finished', title: 'Hi', body: '' })).toEqual(
      denied('finished is not a notification kind of the mod noisy'),
    )
    expect(await callAs(noisy, 'notify.send', { kind: 'alert', title: 'Hi', body: '' })).toEqual(
      denied('alert is not a notification kind of the mod noisy'),
    )
    expect(await callAs(noisy, 'notify.send', { kind: 'other', title: 'Hi', body: '' })).toEqual(
      denied('other is not a notification kind of the mod noisy'),
    )
  })

  it('records only its declared audit kinds, as the mod', async () => {
    valueOf(await callAs(noisy, 'audit.record', { kind: 'summarized', summary: 'Did it', detail: { n: 1 } }))
    expect(await callAs(noisy, 'audit.record', { kind: 'installed', summary: 'Lies' })).toEqual(
      denied('installed is not an audit kind the mod noisy declared'),
    )
    const [row] = await sql<{ actor: string }[]>`SELECT actor FROM audit_event WHERE kind = 'mod.noisy.summarized'`
    expect(row?.actor).toBe('mod:noisy')
  })
})

describe('status.set', () => {
  const status = probeManifest([], {
    commands: [{ id: 'run', title: 'Run', for: ['palette'] }],
    statusBar: [{ id: 'count', title: 'Count', command: 'run' }],
  })

  it('sets only its declared items, at most once a second', async () => {
    valueOf(await callAs(status, 'status.set', { item: 'count', text: '3 open' }))
    expect(modStatusItems.get('probe.count')).toMatchObject({ mod: 'probe', text: '3 open', icon: null })
    expect(await callAs(status, 'status.set', { item: 'count', text: '4 open' })).toEqual({
      ok: false,
      error: { code: 'limit', message: 'count changes at most once a second' },
    })
    expect(await callAs(status, 'status.set', { item: 'other', text: 'x' })).toEqual(
      denied('other is not a status bar item the mod probe declared'),
    )
    expect(await callAs(status, 'status.set', { item: 'count', text: 'x'.repeat(41) })).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    })
  })
})

describe('agents.context', () => {
  const manifest = probeManifest([{ name: 'agents.context', agents: [builder.handle] }], {
    settings: { team: { type: 'string', title: 'Team', default: 'core' } },
    contextProviders: [{ id: 'house', title: 'House rules', text: 'Team {{settings.team}} writes tests first.' }],
  })

  it("reaches only the filtered agents, wrapped as the mod's", async () => {
    const disposers: (() => void)[] = []
    registerModContext(manifest, { 'agents.context': { name: 'agents.context', agents: [builder.handle] } }, (d) => {
      disposers.push(d)
      return d
    })
    expect(await modContextPrompt(builder.task.id)).toBe(
      '<mod_context mod="probe">\nWritten by the probe mod, not by the user.\nTeam core writes tests first.\n</mod_context>',
    )
    expect(await modContextPrompt(other.task.id)).toBeNull()
    expect(contextForConsent(manifest)).toEqual([
      { id: 'house', title: 'House rules', text: 'Team [Team] writes tests first.' },
    ])
    for (const dispose of disposers) {
      dispose()
    }
    expect(await modContextPrompt(builder.task.id)).toBeNull()
  })
})
