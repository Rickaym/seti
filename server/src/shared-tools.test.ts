import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  auditQuery,
  SHARED_TOOL_BYTES_MAX,
  type ChangeRequest,
  type SetiControlLevel,
  type SharedToolChange,
  type Task,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { answerChangeRequest } from './change-requests.js'
import { SHARED_TOOLS_ROOT } from './config.js'
import { createConnectionPlaceholder, setConnectionProfiles } from './connections.js'
import { messages, tasks } from './db.js'
import { SETI_TOOLS } from './seti-tools/catalog.js'
import { REQUEST_TOOLS } from './seti-tools/requests.js'
import { callSetiTool } from './seti-tools/server.js'
import { toolFolder } from './shared-tool-files.js'
import {
  removeSharedTool,
  setSharedToolEnabled,
  sharedToolPlugins,
  syncSharedTools,
  toolReach,
} from './shared-tools.js'
import { auditEvents } from './store/audit.js'
import { sharedTools } from './store/shared-tools.js'
import { sha256 } from './task-files.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const app = createApp()
const [requestChange] = REQUEST_TOOLS
const DESCRIPTION = 'Use it to list the open invoices of a customer: run it with the customer id.'

async function newTask(level: SetiControlLevel = 'self', sandbox = true): Promise<Task> {
  const id = randomUUID()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-tool-agent-'))
  await tasks.insert({
    id,
    title: `Toolsmith ${id.slice(0, 8)}`,
    repo_id: null,
    cwd,
    worktree: false,
    pr_urls: [],
    seti_control: level,
    sandbox,
  })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('task was not stored')
  }
  return task
}

function script(task: Task, name: string, content: string): string {
  const file = path.join(task.cwd, name)
  fs.writeFileSync(file, content)
  return file
}

async function call(tool: string, caller: Task, args: object) {
  const entry = [...REQUEST_TOOLS, ...SETI_TOOLS].find((candidate) => candidate.name === tool)
  if (entry === undefined) {
    throw new Error(`no seti tool ${tool}`)
  }
  const result = await callSetiTool(entry, caller.id, args)
  const text = result.content.map((block) => block.text).join('')
  return { text, isError: 'isError' in result, json: (): unknown => JSON.parse(text) }
}

const propose = async (caller: Task, change: object) =>
  call(requestChange?.name ?? '', caller, {
    change: { kind: 'shared_tool', description: DESCRIPTION, ...change },
    reason: 'Other agents keep asking me to look invoices up for them.',
  })

async function filed(caller: Task, change: object): Promise<ChangeRequest & { change: SharedToolChange }> {
  const result = await propose(caller, change)
  expect(result.text).toContain('Filed')
  return (result.json() as { request: ChangeRequest & { change: SharedToolChange } }).request
}

const send = async (method: string, url: string, body?: object, auth: Record<string, string> = USER_AUTH) =>
  app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const answer = async (task: Task, id: string, decision: 'allow' | 'deny', auth = USER_AUTH) =>
  send('POST', `/tasks/${task.id}/change-requests/${id}`, { decision }, auth)

const lastAudit = async (kind: string) => (await auditEvents.page(auditQuery.parse({ kind, limit: 1 }))).events.at(0)

/** Publishes a script under a new name and returns the name. */
async function published(content = '#!/usr/bin/env python3\nprint("invoices")\n', needs: object[] = []) {
  const caller = await newTask()
  const name = `tool-${randomUUID().slice(0, 8)}`
  const request = await filed(caller, { name, path: script(caller, 'invoices.py', content), needs })
  expect((await answer(caller, request.id, 'allow')).status).toBe(200)
  return { name, caller, request }
}

describe('proposing a shared tool', () => {
  it('keeps the script as it was read, flags its reach and audits name and hash without the code', async () => {
    const caller = await newTask()
    const body = '#!/usr/bin/env python3\nprint("secret-free body")\n'
    const file = script(caller, 'invoices.py', body)
    const request = await filed(caller, { name: 'invoices', path: 'invoices.py' })
    expect(request.change).toMatchObject({
      name: 'invoices',
      needs: [],
      snapshot: { file: 'invoices.py', content: body, sha256: sha256(body), replaces: null },
    })
    expect(request.flags).toEqual(['Every sandboxed agent will be able to run this'])
    expect((await tasks.get(caller.id))?.blocked).toBe('Asks for the shared tool invoices')
    const event = await lastAudit('shared_tool.proposed')
    expect(event).toMatchObject({
      actor: 'agent',
      subject_type: 'shared_tool',
      subject_id: 'invoices',
      detail: { name: 'invoices', sha256: sha256(body), task_id: caller.id, request_id: request.id },
    })
    expect(JSON.stringify(event)).not.toContain('secret-free body')

    fs.writeFileSync(file, 'print("edited after asking")\n')
    expect((await answer(caller, request.id, 'allow')).status).toBe(200)
    expect((await sharedTools.get('invoices'))?.content).toBe(body)
    await sharedTools.remove('invoices')
  })

  it('names who gets a tool that needs a key', async () => {
    const caller = await newTask()
    const request = await filed(caller, {
      name: 'ledger',
      path: script(caller, 'ledger.sh', 'curl -H "x-key: $LEDGER_KEY" https://api.ledger.test/\n'),
      needs: [{ env: 'LEDGER_KEY', hosts: ['api.ledger.test'] }],
    })
    expect(request.flags).toEqual(['Every sandboxed agent whose credential has LEDGER_KEY will be able to run this'])
  })

  it('refuses a script that is too large, a symlink, a folder and a path outside the agent', async () => {
    const caller = await newTask()
    const large = script(caller, 'large.py', 'x'.repeat(SHARED_TOOL_BYTES_MAX + 1))
    expect((await propose(caller, { name: 'large', path: large })).text).toContain('at most 64 KB')
    const real = script(caller, 'real.py', 'print(1)\n')
    fs.symlinkSync(real, path.join(caller.cwd, 'link.py'))
    expect((await propose(caller, { name: 'link', path: 'link.py' })).text).toContain('is a symlink')
    fs.mkdirSync(path.join(caller.cwd, 'pack'))
    expect((await propose(caller, { name: 'pack', path: 'pack' })).text).toContain('not a regular file')
    const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-tool-other-')), 'theirs.py')
    fs.writeFileSync(elsewhere, 'print(2)\n')
    for (const outside of [elsewhere, '/etc/hostname', '../theirs.py']) {
      expect((await propose(caller, { name: 'outside', path: outside })).isError).toBe(true)
    }
    expect((await propose(caller, { name: 'outside', path: elsewhere })).text).toContain('outside your working folders')
    fs.symlinkSync(path.dirname(elsewhere), path.join(caller.cwd, 'their-folder'))
    expect((await propose(caller, { name: 'outside', path: 'their-folder/theirs.py' })).text).toContain(
      'outside your working folders',
    )
    expect((await propose(caller, { name: 'gone', path: 'gone.py' })).text).toContain('does not exist')
  })

  it('refuses text that is not UTF-8, extra fields, a value and a description with backticks', async () => {
    const caller = await newTask()
    fs.writeFileSync(path.join(caller.cwd, 'binary.py'), Buffer.from([0xff, 0xfe, 0x00, 0x41]))
    expect((await propose(caller, { name: 'binary', path: 'binary.py' })).text).toContain('not UTF-8 text')
    const file = script(caller, 'plain.py', 'print(3)\n')
    expect((await propose(caller, { name: 'plain', path: file, value: 'sk-live-123' })).isError).toBe(true)
    const keyed = { env: 'PLAIN_KEY', hosts: ['api.plain.test'], value: 'sk-live-123' }
    expect((await propose(caller, { name: 'plain', path: file, needs: [keyed] })).isError).toBe(true)
    expect((await propose(caller, { name: 'Plain Tool', path: file })).isError).toBe(true)
    const injected = await propose(caller, { name: 'plain', path: file, description: `${DESCRIPTION} !\`id\`` })
    expect(injected.text).toContain('without backticks')
    expect(await sharedTools.get('plain')).toBeUndefined()
  })

  it('lets an unsandboxed agent propose, and says when the same code is published already', async () => {
    const caller = await newTask('self', false)
    const body = 'print("same")\n'
    const request = await filed(caller, { name: 'same-tool', path: script(caller, 'same.py', body) })
    expect((await answer(caller, request.id, 'allow')).status).toBe(200)
    const again = await propose(caller, { name: 'same-tool', path: 'same.py' })
    expect(again.text).toContain('is published with this code')
    await sharedTools.remove('same-tool')
  })
})

describe('answering a proposal', () => {
  it("is the user's alone: the EA and agents are refused and nothing is published", async () => {
    const caller = await newTask('full')
    const request = await filed(caller, { name: 'guarded', path: script(caller, 'guarded.py', 'print(4)\n') })
    expect((await answer(caller, request.id, 'allow', EA_AUTH)).status).toBe(403)
    await expect(
      asAgent(caller, async () => answerChangeRequest(caller, request.id, { decision: 'allow' })),
    ).rejects.toThrow(/Agents cannot/)
    expect(await sharedTools.get('guarded')).toBeUndefined()
    expect(fs.existsSync(SHARED_TOOLS_ROOT) ? fs.readdirSync(SHARED_TOOLS_ROOT) : []).not.toContain('guarded')

    expect((await answer(caller, request.id, 'deny')).status).toBe(200)
    expect(await sharedTools.get('guarded')).toBeUndefined()
    expect(await lastAudit('shared_tool.denied')).toMatchObject({
      actor: 'user',
      detail: { name: 'guarded', task_id: caller.id, request_id: request.id },
    })
  })

  it('publishes the snapshot as a plugin folder with a skill and the script, and tells the agent', async () => {
    const body = '#!/usr/bin/env python3\nprint("published")\n'
    const needs = [{ env: 'BILLING_KEY', hosts: ['api.billing.test'] }]
    const { name, caller, request } = await published(body, needs)
    const tool = await sharedTools.get(name)
    expect(tool).toMatchObject({ file: 'invoices.py', sha256: sha256(body), enabled: true, needs })
    expect(tool).toMatchObject({ proposer_task_id: caller.id, proposer_title: caller.title })
    const dir = toolFolder({ name, sha256: sha256(body) })
    expect(path.dirname(dir)).toBe(SHARED_TOOLS_ROOT)
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) as object
    expect(manifest).toMatchObject({ name: `seti-${name}` })
    const skill = fs.readFileSync(path.join(dir, 'skills', name, 'SKILL.md'), 'utf8')
    expect(skill).toContain(`---\nname: ${name}\ndescription: ${JSON.stringify(DESCRIPTION)}\n---\n`)
    expect(skill).toContain('"${CLAUDE_SKILL_DIR}/invoices.py"')
    expect(skill).toContain('`BILLING_KEY`, sent to api.billing.test')
    const scriptFile = path.join(dir, 'skills', name, 'invoices.py')
    expect(fs.readFileSync(scriptFile, 'utf8')).toBe(body)
    expect(fs.statSync(scriptFile).mode & 0o777).toBe(0o555)

    const event = await lastAudit('shared_tool.allowed')
    expect(event).toMatchObject({
      actor: 'user',
      subject_id: name,
      detail: { name, sha256: sha256(body), task_id: caller.id, request_id: request.id },
    })
    expect(JSON.stringify(event)).not.toContain('published')
    const told = (await messages.page(caller.id, 20)).messages.flatMap((row) =>
      row.kind === 'input' && row.payload.source === 'seti' ? [row.payload.title] : [],
    )
    expect(told).toContain(`The user published your shared tool ${name}`)
    await sharedTools.remove(name)
  })

  it('shows an update against the published version, replaces its folder and refuses a stale one', async () => {
    const first = 'print("one")\n'
    const { name, caller } = await published(first)
    const second = 'print("one")\nprint("two")\n'
    const update = await filed(caller, { name, path: script(caller, 'invoices.py', second) })
    expect(update.change.snapshot.replaces).toEqual({ sha256: sha256(first), content: first })
    expect(update.flags).toContain(`Replaces the published ${name}`)
    const other = await newTask()
    const stale = await filed(other, { name, path: script(other, 'invoices.py', 'print("other")\n') })

    expect((await answer(caller, update.id, 'allow')).status).toBe(200)
    expect((await sharedTools.get(name))?.sha256).toBe(sha256(second))
    expect(fs.existsSync(toolFolder({ name, sha256: sha256(second) }))).toBe(true)
    expect(fs.existsSync(toolFolder({ name, sha256: sha256(first) }))).toBe(false)

    const refused = await answer(other, stale.id, 'allow')
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('changed after the agent asked')
    expect((await sharedTools.get(name))?.sha256).toBe(sha256(second))
    await sharedTools.remove(name)
  })
})

describe('which agents load a shared tool', () => {
  const need = [{ env: 'REACH_KEY', hosts: ['api.reach.test'] }]

  it.each([
    ['no needs', { enabled: true, needs: [] }, { sandboxed: true, envs: [] }, true],
    ['needs met', { enabled: true, needs: need }, { sandboxed: true, envs: ['OTHER', 'REACH_KEY'] }, true],
    ['needs missing', { enabled: true, needs: need }, { sandboxed: true, envs: ['OTHER'] }, false],
    ['unsandboxed', { enabled: true, needs: [] }, { sandboxed: false, envs: [] }, false],
    ['disabled', { enabled: false, needs: [] }, { sandboxed: true, envs: [] }, false],
  ])('%s', (_label, tool, agent, available) => {
    expect(toolReach(tool, agent).available).toBe(available)
  })

  it('names the variables an agent lacks', () => {
    expect(toolReach({ enabled: true, needs: need }, { sandboxed: true, envs: [] })).toMatchObject({
      missing: ['REACH_KEY'],
      why: expect.stringContaining('request_change') as string,
    })
  })

  it('loads a tool with needs once the credential carries the connection, and lists what is missing', async () => {
    const env = `LOAD_KEY_${randomUUID().slice(0, 6).toUpperCase()}`
    const { name, caller } = await published('print("load")\n', [{ env, hosts: ['api.load.test'] }])
    const open = await published('print("open")\n')
    const dir = toolFolder((await sharedTools.get(name)) ?? { name, sha256: '' })
    const paths = async (task: Task) => (await sharedToolPlugins(task)).map((plugin) => plugin.path)
    expect(await paths(caller)).not.toContain(dir)
    expect(await paths(caller)).toContain(toolFolder((await sharedTools.get(open.name)) ?? open))
    const listing = await call('list_plugins', caller, {})
    const listed = (listing.json() as { shared_tools: { name: string }[] }).shared_tools
    expect(listed.find((tool) => tool.name === name)).toMatchObject({ available: false, missing: [env] })
    expect(listed.find((tool) => tool.name === open.name)).toMatchObject({
      available: true,
      skill: `seti-${open.name}:${open.name}`,
    })

    const connection = await createConnectionPlaceholder(
      { name: env.toLowerCase(), env, hosts: ['api.load.test'], adds_header: false },
      'user',
    )
    await setConnectionProfiles(connection.id, [caller.profile_id])
    expect(await paths(caller)).toContain(dir)
    expect(await paths(await newTask('self', false))).toEqual([])

    fs.rmSync(dir, { recursive: true })
    expect(await paths(caller)).not.toContain(dir)
    await syncSharedTools()
    expect(await paths(caller)).toContain(dir)
    await sharedTools.remove(name)
    await sharedTools.remove(open.name)
  })
})

describe('managing shared tools', () => {
  it('lets the EA and agents with Full turn one off, and only the user turn it on', async () => {
    const { name } = await published()
    const full = await newTask('full')
    expect((await call('disable_tool', await newTask('self'), { tool: name })).isError).toBe(true)
    expect((await sharedTools.get(name))?.enabled).toBe(true)
    expect((await call('disable_tool', full, { tool: name })).isError).toBe(false)
    expect((await sharedTools.get(name))?.enabled).toBe(false)
    expect(await lastAudit('shared_tool.disabled')).toMatchObject({ actor: 'agent', detail: { name } })
    expect(await sharedToolPlugins(full)).toEqual([])

    expect((await send('PATCH', `/shared-tools/${name}`, { enabled: true }, EA_AUTH)).status).toBe(403)
    await expect(asAgent(full, async () => setSharedToolEnabled(name, true))).rejects.toThrow(/Agents cannot/)
    expect((await sharedTools.get(name))?.enabled).toBe(false)
    expect((await send('PATCH', `/shared-tools/${name}`, { enabled: true })).status).toBe(200)
    expect(await lastAudit('shared_tool.enabled')).toMatchObject({ actor: 'user', detail: { name } })
    expect((await send('PATCH', `/shared-tools/${name}`, { enabled: false }, EA_AUTH)).status).toBe(200)
    expect((await sharedTools.get(name))?.enabled).toBe(false)
    await sharedTools.remove(name)
  })

  it('serves the list without the code and one tool with it', async () => {
    const body = 'print("listed")\n'
    const { name } = await published(body)
    const list = (await (await send('GET', '/shared-tools')).json()) as { data: Record<string, unknown>[] }
    const row = list.data.find((tool) => tool.name === name)
    expect(row).toMatchObject({ name, sha256: sha256(body), bytes: body.length })
    expect(row).not.toHaveProperty('content')
    const one = (await (await send('GET', `/shared-tools/${name}`)).json()) as { data: object }
    expect(one.data).toMatchObject({ name, content: body })
    expect((await send('GET', '/shared-tools/No_Such')).status).toBe(400)
    expect((await send('GET', '/shared-tools/no-such')).status).toBe(404)
    await sharedTools.remove(name)
  })

  it('removes the tool and its folder for the user, and refuses an agent', async () => {
    const { name } = await published()
    const tool = await sharedTools.get(name)
    const dir = toolFolder(tool ?? { name, sha256: '' })
    await expect(asAgent(await newTask('full'), async () => removeSharedTool(name))).rejects.toThrow(/Agents cannot/)
    expect(fs.existsSync(dir)).toBe(true)
    expect((await send('DELETE', `/shared-tools/${name}`)).status).toBe(204)
    expect(await sharedTools.get(name)).toBeUndefined()
    expect(fs.existsSync(dir)).toBe(false)
    expect(await lastAudit('shared_tool.removed')).toMatchObject({
      actor: 'user',
      subject_id: name,
      detail: { name, sha256: tool?.sha256 },
    })
    expect((await send('DELETE', `/shared-tools/${name}`)).status).toBe(404)
  })
})
