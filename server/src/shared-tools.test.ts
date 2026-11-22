import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import {
  auditQuery,
  SHARED_TOOL_BYTES_MAX,
  toolInput,
  type ChangeRequest,
  type SetiControlLevel,
  type SharedToolChange,
  type SharedToolDefinition,
  type Task,
} from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { findBinary } from './binaries.js'
import { answerChangeRequest } from './change-requests.js'
import { SETI_HOME, SHARED_TOOLS_ROOT } from './config.js'
import { createConnectionPlaceholder, setConnectionProfiles } from './connections.js'
import { messages, tasks } from './db.js'
import { isOutward } from './outward.js'
import { permissionSettings, sandboxFor } from './session-options.js'
import { sessionOptions, setupKey } from './session-spec.js'
import { SETI_TOOLS } from './seti-tools/catalog.js'
import { REQUEST_TOOLS } from './seti-tools/requests.js'
import { callSetiTool } from './seti-tools/server.js'
import { toolFolder, toolHash } from './shared-tool-files.js'
import {
  removeSharedTool,
  setSharedToolEnabled,
  sharedToolFolders,
  syncSharedTools,
  TOOL_SERVER,
  toolReach,
} from './shared-tools.js'
import { auditEvents } from './store/audit.js'
import { sharedTools } from './store/shared-tools.js'
import { removeTaskSandbox } from './task-sandbox.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const bwrapWorks = (() => {
  try {
    findBinary('socat')
    execFileSync(findBinary('bwrap'), ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', 'true'])
    return true
  } catch {
    return false
  }
})()

/** Allow and Deny hand the agent its update at once, which starts a turn of this fake session. */
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  const fake = new FakeSdk(function* () {
    yield fakeResult()
  })
  return { ...(await importOriginal<typeof Sdk>()), query: fake.query }
})

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

const INPUT = {
  type: 'object',
  properties: { customer: { type: 'string', description: 'The customer id.' } },
  required: ['customer'],
}

/** The hash Seti gives a published tool: its definition and its script together. */
const hashOf = (name: string, content: string, fields: Partial<SharedToolDefinition> = {}) =>
  toolHash({
    name,
    description: DESCRIPTION,
    input: toolInput.parse(INPUT),
    writes: false,
    timeout_seconds: 120,
    needs: [],
    file: 'invoices.py',
    content,
    ...fields,
  })

const propose = async (caller: Task, change: object) =>
  call(requestChange?.name ?? '', caller, {
    change: { kind: 'shared_tool', description: DESCRIPTION, input: INPUT, writes: false, ...change },
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
      input: INPUT,
      writes: false,
      timeout_seconds: 120,
      snapshot: { file: 'invoices.py', content: body, sha256: hashOf('invoices', body), replaces: null },
    })
    expect(request.flags).toEqual([
      'Every agent will be able to run this',
      'An agent without the sandbox runs it with your access to this machine',
    ])
    expect((await tasks.get(caller.id))?.blocked).toBe('Asks for the shared tool invoices')
    const event = await lastAudit('shared_tool.proposed')
    expect(event).toMatchObject({
      actor: 'agent',
      subject_type: 'shared_tool',
      subject_id: 'invoices',
      detail: { name: 'invoices', sha256: hashOf('invoices', body), task_id: caller.id, request_id: request.id },
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
    expect(request.flags).toContain('Every agent whose credential has LEDGER_KEY will be able to run this')
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

  it('refuses text that is not UTF-8, extra fields, a value and a script with no way to start', async () => {
    const caller = await newTask()
    fs.writeFileSync(path.join(caller.cwd, 'binary.py'), Buffer.from([0xff, 0xfe, 0x00, 0x41]))
    expect((await propose(caller, { name: 'binary', path: 'binary.py' })).text).toContain('not UTF-8 text')
    const file = script(caller, 'plain.py', 'print(3)\n')
    expect((await propose(caller, { name: 'plain', path: file, value: 'sk-live-123' })).isError).toBe(true)
    const keyed = { env: 'PLAIN_KEY', hosts: ['api.plain.test'], value: 'sk-live-123' }
    expect((await propose(caller, { name: 'plain', path: file, needs: [keyed] })).isError).toBe(true)
    expect((await propose(caller, { name: 'Plain Tool', path: file })).isError).toBe(true)
    script(caller, 'notes.txt', 'no way to start this\n')
    expect((await propose(caller, { name: 'plain', path: 'notes.txt' })).text).toContain('needs a #! first line')
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

  it('publishes the snapshot as a folder with tool.json and the script, and tells the agent', async () => {
    const body = '#!/usr/bin/env python3\nprint("published")\n'
    const needs = [{ env: 'BILLING_KEY', hosts: ['api.billing.test'] }]
    const { name, caller, request } = await published(body, needs)
    const tool = await sharedTools.get(name)
    const hash = hashOf(name, body, { needs })
    expect(tool).toMatchObject({ file: 'invoices.py', sha256: hash, enabled: true, needs, writes: false })
    expect(tool).toMatchObject({ proposer_task_id: caller.id, proposer_title: caller.title })
    const dir = toolFolder({ name, sha256: hash })
    expect(path.dirname(dir)).toBe(SHARED_TOOLS_ROOT)
    expect(new Set(fs.readdirSync(dir))).toEqual(new Set(['invoices.py', 'tool.json']))
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'tool.json'), 'utf8')) as object
    expect(manifest).toEqual({
      name,
      description: DESCRIPTION,
      input: INPUT,
      writes: false,
      timeout_seconds: 120,
      needs,
      file: 'invoices.py',
      run: ['/usr/bin/env', 'python3'],
    })
    const scriptFile = path.join(dir, 'invoices.py')
    expect(fs.readFileSync(scriptFile, 'utf8')).toBe(body)
    expect(fs.statSync(scriptFile).mode & 0o777).toBe(0o444)

    const event = await lastAudit('shared_tool.allowed')
    expect(event).toMatchObject({
      actor: 'user',
      subject_id: name,
      detail: { name, sha256: hash, task_id: caller.id, request_id: request.id },
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
    expect(update.change.snapshot.replaces).toMatchObject({ sha256: hashOf(name, first), content: first })
    expect(update.change.snapshot.replaces?.definition).toContain('"writes": false')
    expect(update.flags).toContain(`Replaces the published ${name}`)
    const other = await newTask()
    const stale = await filed(other, { name, path: script(other, 'invoices.py', 'print("other")\n') })

    expect((await answer(caller, update.id, 'allow')).status).toBe(200)
    expect((await sharedTools.get(name))?.sha256).toBe(hashOf(name, second))
    expect(fs.existsSync(toolFolder({ name, sha256: hashOf(name, second) }))).toBe(true)
    expect(fs.existsSync(toolFolder({ name, sha256: hashOf(name, first) }))).toBe(false)

    const refused = await answer(other, stale.id, 'allow')
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('changed after the agent asked')
    expect((await sharedTools.get(name))?.sha256).toBe(hashOf(name, second))

    const sameCode = await filed(caller, { name, path: 'invoices.py', writes: true })
    expect(sameCode.change.snapshot.sha256).toBe(hashOf(name, second, { writes: true }))
    expect(sameCode.change.snapshot.replaces?.content).toBe(second)
    expect((await answer(caller, sameCode.id, 'allow')).status).toBe(200)
    expect(await sharedTools.get(name)).toMatchObject({ writes: true, sha256: sameCode.change.snapshot.sha256 })
    expect(isOutward(`mcp__shared__${name}`, {})).toBe(true)
    await sharedTools.remove(name)
  })

  it.each([
    ['a $ref', { type: 'object', properties: { a: { $ref: 'https://schemas.example.com/a.json' } } }],
    ['an unknown keyword', { type: 'object', properties: { a: { type: 'string', pattern: '.*' } } }],
    ['a required name with no property', { type: 'object', properties: {}, required: ['a'] }],
    ['a top level that is not an object', { type: 'string' }],
    [
      'arguments nested too deep',
      {
        type: 'object',
        properties: {
          a: {
            type: 'array',
            items: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'string' } } } },
          },
        },
      },
    ],
  ])('refuses an argument schema with %s', async (_label, input) => {
    const caller = await newTask()
    const result = await propose(caller, { name: 'schema', path: script(caller, 'schema.py', 'print(5)\n'), input })
    expect(result.isError).toBe(true)
  })
})

describe('which agents load a shared tool', () => {
  const need = [{ env: 'REACH_KEY', hosts: ['api.reach.test'] }]
  const carries = (hosts: string[]) => [
    { env: 'OTHER', hosts: [] },
    { env: 'REACH_KEY', hosts },
  ]

  it.each([
    ['no needs', { enabled: true, needs: [] }, [], true],
    ['needs met', { enabled: true, needs: need }, carries(['api.reach.test']), true],
    ['needs met by a wildcard', { enabled: true, needs: need }, carries(['*.reach.test']), true],
    ['needs missing', { enabled: true, needs: need }, [{ env: 'OTHER', hosts: [] }], false],
    ['the variable on other hosts', { enabled: true, needs: need }, carries(['api.other.test']), false],
    ['turned off', { enabled: false, needs: [] }, [], false],
  ])('%s', (_label, tool, carried, available) => {
    expect(toolReach(tool, carried).available).toBe(available)
  })

  it('names the variables an agent lacks', () => {
    expect(toolReach({ enabled: true, needs: need }, [])).toMatchObject({
      missing: ['REACH_KEY'],
      why: expect.stringContaining('request_change') as string,
    })
  })

  it('loads a tool with needs once the credential carries the connection, sandboxed or not', async () => {
    const env = `LOAD_KEY_${randomUUID().slice(0, 6).toUpperCase()}`
    const { name, caller } = await published('print("load")\n', [{ env, hosts: ['api.load.test'] }])
    const open = await published('print("open")\n')
    const dir = toolFolder((await sharedTools.get(name)) ?? { name, sha256: '' })
    const openDir = toolFolder({ name: open.name, sha256: hashOf(open.name, 'print("open")\n') })
    expect(await sharedToolFolders(caller)).toEqual([openDir])
    const listing = await call('list_plugins', caller, {})
    const listed = (listing.json() as { shared_tools: { name: string }[] }).shared_tools
    expect(listed.find((tool) => tool.name === name)).toMatchObject({ available: false, missing: [env] })
    expect(listed.find((tool) => tool.name === open.name)).toMatchObject({
      available: true,
      tool: `mcp__shared__${open.name}`,
    })

    const connection = await createConnectionPlaceholder(
      { name: env.toLowerCase(), env, hosts: ['api.load.test'], adds_header: false },
      'user',
    )
    await setConnectionProfiles(connection.id, [caller.profile_id])
    expect(await sharedToolFolders(caller)).toContain(dir)
    expect(await sharedToolFolders(await newTask('self', false))).toContain(dir)

    fs.rmSync(dir, { recursive: true })
    expect(await sharedToolFolders(caller)).not.toContain(dir)
    await syncSharedTools()
    expect(await sharedToolFolders(caller)).toContain(dir)
    await sharedTools.remove(name)
    await sharedTools.remove(open.name)
  })
})

describe('how a session gets its shared tools', () => {
  it('offers them through one stdio MCP server that Claude Code starts, and restarts on a change', async () => {
    const unsandboxed = await newTask('self', false)
    const before = await setupKey(unsandboxed)
    expect((await sessionOptions(unsandboxed, new AbortController())).mcpServers).not.toHaveProperty('shared')
    const { name } = await published('#!/bin/sh\ncat\n')
    const dir = toolFolder((await sharedTools.get(name)) ?? { name, sha256: '' })
    const options = await sessionOptions(unsandboxed, new AbortController())
    expect(options.mcpServers?.shared).toEqual({ type: 'stdio', command: process.execPath, args: [TOOL_SERVER, dir] })
    expect(options.spawnClaudeCodeProcess).toBeUndefined()
    expect(await setupKey(unsandboxed)).not.toBe(before)
    const rules = await permissionSettings(unsandboxed)
    expect(rules.allow).not.toContain('mcp__shared')
    expect((await permissionSettings(await newTask())).allow).toContain('mcp__shared')
    await sharedTools.remove(name)
  })

  it.skipIf(!bwrapWorks)(
    'starts the server of a sandboxed agent through the sandbox wrapper, where its scripts run',
    async () => {
      const body = [
        '#!/bin/sh',
        'cat > /dev/null',
        'echo "host=$(cat /proc/sys/kernel/hostname)"',
        'touch "$(dirname "$0")/written" 2> /dev/null && echo "wrote" || echo "read-only"',
        `ls "${SETI_HOME}/credentials" > /dev/null 2>&1 && echo "sees-secrets" || echo "no-secrets"`,
        '',
      ].join('\n')
      const { name } = await published(body)
      const dir = toolFolder((await sharedTools.get(name)) ?? { name, sha256: '' })
      fs.mkdirSync(path.join(SETI_HOME, 'credentials'), { recursive: true })
      const task = await newTask()
      const options = await sessionOptions(task, new AbortController())
      const server = options.mcpServers?.shared
      expect(server).toEqual({ type: 'stdio', command: process.execPath, args: [TOOL_SERVER, dir] })
      expect(options.spawnClaudeCodeProcess).toBeTypeOf('function')

      const sandbox = await sandboxFor(task)
      const wrapped = sandbox?.command(process.execPath, [TOOL_SERVER, dir])
      expect(path.basename(wrapped?.program ?? '')).not.toBe(path.basename(process.execPath))
      expect(wrapped?.args.join(' ')).toContain(`--ro-bind ${dir} ${dir}`)

      const child = sandbox?.spawn(process.execPath, [TOOL_SERVER, dir], { stdin: 'pipe' })
      let out = ''
      child?.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
      const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { customer: 'c1' } } }
      child?.stdin?.end(`${JSON.stringify(request)}\n`)
      await new Promise((resolve) => child?.on('exit', resolve))
      const reply = JSON.parse(out) as { result: { content: { text: string }[]; isError: boolean } }
      expect(reply.result.isError).toBe(false)
      expect(reply.result.content[0]?.text.trim().split('\n')).toEqual(['host=seti-sandbox', 'read-only', 'no-secrets'])
      expect(fs.existsSync(path.join(dir, 'written'))).toBe(false)
      await removeTaskSandbox(task.id)
      await sharedTools.remove(name)
    },
  )
})

describe('managing shared tools', () => {
  it('lets the EA turn one off, only the user turn it on, and agents do neither', async () => {
    const { name } = await published()
    const full = await newTask('full')
    expect(SETI_TOOLS.map((tool) => tool.name)).not.toContain('disable_tool')
    await expect(asAgent(full, async () => setSharedToolEnabled(name, false))).rejects.toThrow(/Agents cannot/)
    expect((await sharedTools.get(name))?.enabled).toBe(true)
    expect((await send('PATCH', `/shared-tools/${name}`, { enabled: false }, EA_AUTH)).status).toBe(200)
    expect((await sharedTools.get(name))?.enabled).toBe(false)
    expect(await lastAudit('shared_tool.disabled')).toMatchObject({ actor: 'user', detail: { name, via: 'ea' } })
    expect(await sharedToolFolders(full)).toEqual([])

    expect((await send('PATCH', `/shared-tools/${name}`, { enabled: true }, EA_AUTH)).status).toBe(403)
    await expect(asAgent(full, async () => setSharedToolEnabled(name, true))).rejects.toThrow(/Agents cannot/)
    expect((await sharedTools.get(name))?.enabled).toBe(false)
    expect((await send('PATCH', `/shared-tools/${name}`, { enabled: true })).status).toBe(200)
    expect(await lastAudit('shared_tool.enabled')).toMatchObject({ actor: 'user', detail: { name } })
    await sharedTools.remove(name)
  })

  it('serves the list without the code and one tool with it', async () => {
    const body = 'print("listed")\n'
    const { name } = await published(body)
    const list = (await (await send('GET', '/shared-tools')).json()) as { data: Record<string, unknown>[] }
    const row = list.data.find((tool) => tool.name === name)
    expect(row).toMatchObject({ name, sha256: hashOf(name, body), bytes: body.length, input: INPUT })
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
