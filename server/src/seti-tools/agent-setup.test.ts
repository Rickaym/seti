import fs from 'node:fs'
import path from 'node:path'
import type {
  AuditPage,
  SetiControlLevel,
  ContextPackSummary,
  CpuCapSettings,
  TeamPosted,
  TeamMember,
} from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { tasks } from '../db.js'
import { SETI_TOOLS } from './catalog.js'
import { callSetiTool } from './server.js'
import { teamMessages, USER_READER } from '../store/team.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-tools-setup-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('../fake-sdk.js')
  const fake = new FakeSdk(function* () {
    yield fakeAssistant('ok')
    yield fakeResult()
  })
  return { query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

let count = 0

async function newTask(title: string, cwd: string, setiControl: SetiControlLevel = 'off'): Promise<string> {
  const id = `setup-tools-${String(++count)}`
  fs.mkdirSync(cwd, { recursive: true })
  await tasks.insert({ id, title, repo_id: null, cwd, worktree: false, pr_urls: [], seti_control: setiControl })
  return id
}

async function call(callerId: string, name: string, args: object = {}) {
  const entry = SETI_TOOLS.find((tool) => tool.name === name)
  if (entry === undefined) {
    throw new Error(`No seti tool ${name}`)
  }
  const result = await callSetiTool(entry, callerId, args)
  const text = result.content[0]?.text ?? ''
  return { text, isError: result.isError === true }
}

async function data<T>(callerId: string, name: string, args: object = {}): Promise<T> {
  const result = await call(callerId, name, args)
  expect(result.isError, result.text).toBe(false)
  return JSON.parse(result.text) as T
}

const PR = 'https://github.com/acme/web/pull/42'

describe('agent setup tools', () => {
  it('adds a directory inside the caller and refuses one outside it', async () => {
    const own = path.join(scratch, 'caller-work')
    const caller = await newTask('Setup caller', own, 'full')
    const target = await newTask('Setup target', path.join(scratch, 'target-work'))
    const inside = path.join(own, 'shared')
    fs.mkdirSync(inside)
    const outside = path.join(scratch, 'elsewhere')
    fs.mkdirSync(outside)

    const refused = await call(caller, 'add_agent_directory', { task: target, path: outside })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('inside one of your own')
    await data(caller, 'add_agent_directory', { task: target, path: inside })
    expect((await tasks.get(target))?.dirs).toEqual([inside])

    const cwdRefused = await call(caller, 'remove_from_agent', {
      task: target,
      what: path.join(scratch, 'target-work'),
    })
    expect(cwdRefused.isError).toBe(true)
    await data(caller, 'remove_from_agent', { task: target, what: inside })
    expect((await tasks.get(target))?.dirs).toEqual([])
  })

  it('links and unlinks a PR, audited as the calling agent', async () => {
    const caller = await newTask('Linking caller', path.join(scratch, 'link-caller'), 'full')
    const target = await newTask('Linking target', path.join(scratch, 'link-target'))
    await data(caller, 'link_pr', { task: target, pr: PR })
    expect((await tasks.get(target))?.pr_urls).toEqual([PR])
    const audit = await data<AuditPage>(caller, 'search_audit', { area: 'task.pr_linked', actor: 'agent' })
    const event = audit.events.find((e) => e.subject_id === target)
    expect(event?.detail.agent_id).toBe(caller)
    await data(caller, 'unlink_pr', { task: target, pr: '42' })
    expect((await tasks.get(target))?.pr_urls).toEqual([])
  })

  it('gives a new role and reads access, subagents and the memory and CPU caps', async () => {
    const caller = await newTask('Role caller', path.join(scratch, 'role-caller'), 'full')
    const target = await newTask('Role target', path.join(scratch, 'role-target'))
    const packs = await data<ContextPackSummary[]>(caller, 'set_agent_role', {
      task: target,
      text: 'Review every change twice.',
      name: 'Careful reviewer',
    })
    expect(packs.some((pack) => pack.kind === 'role' && pack.name === 'Careful reviewer')).toBe(true)
    expect((await call(caller, 'set_agent_role', { task: target })).isError).toBe(true)

    const access = await data<{ task_id: string; items: unknown[] }>(caller, 'agent_access', { task: target })
    expect(access.task_id).toBe(target)
    expect(await data<unknown>(caller, 'list_subtasks', { task: target })).toEqual({
      total: 0,
      counts: {},
      subtasks: [],
    })
    const caps = await data<{ cap: object; cpu: CpuCapSettings }>(caller, 'get_memory_cap')
    expect(caps).toHaveProperty('cap')
    expect(caps.cpu).toMatchObject({ weight: 50, enforced: false })
    const own = await data<{ cpu: object }>(caller, 'get_memory_cap', { agent: target })
    expect(own.cpu).toMatchObject({ override: null, used_percent: 0, throttled_now: false, nr_throttled: 0 })
    expect(Array.isArray(await data<unknown[]>(caller, 'list_waiting_updates'))).toBe(true)
  })
})

describe('team tools', () => {
  it('posts to the group chat as the calling agent and mutes another', async () => {
    const caller = await newTask('Chat caller', path.join(scratch, 'chat-caller'), 'full')
    const target = await newTask('Chat target', path.join(scratch, 'chat-target'))
    const posted = await data<TeamPosted>(caller, 'post_team_chat', { text: 'Heads up: the build is green.' })
    expect(posted.message.author_kind).toBe('task')
    expect(posted.message.author_task_id).toBe(caller)
    expect((await teamMessages.list(USER_READER, 1)).at(-1)?.author_task_id).toBe(caller)
    const read = await data<{ author: string; text: string }[]>(caller, 'read_team_chat', { limit: 5 })
    expect(read.at(-1)?.text).toBe('Heads up: the build is green.')

    const member = await data<TeamMember>(caller, 'set_agent_group_chat', { task: target, muted: true })
    expect(member.muted).toBe(true)
    expect((await call(caller, 'set_agent_group_chat', { task: target })).isError).toBe(true)
  })

  it('refuses every tool once Seti control is off', async () => {
    const caller = await newTask('Off caller', path.join(scratch, 'off-caller'))
    const result = await call(caller, 'read_team_chat')
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Seti control is off')
  })
})
