import { auditQuery, type Task } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asAgent } from '../access.js'
import { setAccessDefault, setTaskAccess } from '../agent-access.js'
import { createApp } from '../app.js'
import { setTaskCpuCap, updateCpuCap } from '../cpu-cap.js'
import { messages, tasks } from '../db.js'
import { PROMPT_AS_USER } from '../ea-guard.js'
import { setTaskMemoryCap, updateMemoryCap } from '../memory-cap.js'
import { setPlannerModel } from '../planner.js'
import { runTurn } from '../runner.js'
import { setupKey } from '../session-options.js'
import { setiControlPreface } from '../seti-control-note.js'
import { renderGuide } from '../seti-guide.js'
import { SETI_TOOLS } from './catalog.js'
import { accessDefaults, taskAccess } from '../store/access.js'
import { auditEvents } from '../store/audit.js'
import { sshHostStore } from '../store/ssh.js'
import { retryTask, sendTaskMessage } from '../task-actions.js'
import { setTaskProfile, setTaskSandbox, setTaskSetiControl } from '../tasks.js'
import { ensureMember } from '../team.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { waitIdle } from '../wait-idle.js'
import { callSetiTool, sessionTools, setiToolsContext } from './server.js'

const sdk = await vi.hoisted(async () => {
  const fakes = await import('../fake-sdk.js')
  const fake = new fakes.FakeSdk(async function* () {
    await Promise.resolve()
    yield fakes.fakeMessage('system', {
      subtype: 'init',
      session_id: 'seti',
      model: 'haiku',
      permissionMode: 'default',
    })
    yield fakes.fakeResult()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
let count = 0

async function newTask(extra: Partial<Pick<Task, 'seti_control'>> = {}): Promise<Task> {
  const id = `seti-control-${String(++count)}`
  await tasks.insert({
    id,
    title: `Agent ${String(count)}`,
    repo_id: null,
    cwd: '/tmp',
    worktree: false,
    pr_urls: [],
    ...extra,
  })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('task was not stored')
  }
  return task
}

const request = async (method: string, url: string, body: unknown, auth = USER_AUTH) =>
  app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

function toolNamed(name: string) {
  const found = SETI_TOOLS.find((entry) => entry.name === name)
  if (!found) {
    throw new Error(`no seti tool ${name}`)
  }
  return found
}

async function call(caller: Task, name: string, args: unknown) {
  const result = await callSetiTool(toolNamed(name), caller.id, args)
  return { text: result.content.map((block) => block.text).join(''), isError: 'isError' in result }
}

afterEach(() => {
  setPlannerModel(async () => Promise.reject(new Error('no model in tests')))
})

describe('the Seti control level', () => {
  it('is Self for new agents, and only the user changes it', async () => {
    const task = await newTask()
    expect(task.seti_control).toBe('self')
    for (const level of ['full', 'off'] as const) {
      const ea = await request('PATCH', `/tasks/${task.id}`, { seti_control: level }, EA_AUTH)
      expect(ea.status).toBe(403)
      expect(((await ea.json()) as { error: { detail: string } }).error.detail).toContain('Seti control')
    }
    expect((await request('PATCH', `/tasks/${task.id}`, { seti_control: 'full' })).status).toBe(200)
    expect((await tasks.get(task.id))?.seti_control).toBe('full')
    const [event] = (await auditEvents.page(auditQuery.parse({ kind: 'task.access_changed', limit: 1 }))).events
    expect(event).toMatchObject({
      actor: 'user',
      subject_id: task.id,
      summary: `Set Seti control of task "${task.title}" to Full`,
      detail: { seti_control: 'full', previous: 'self' },
    })
    expect((await request('PATCH', `/tasks/${task.id}`, { seti_control: true })).status).toBe(400)
  })

  it('cannot be asked for at Full by the EA when it creates an agent', async () => {
    const res = await request('POST', '/tasks', { prompt: 'hi', cwd: '/tmp', seti_control: 'full' }, EA_AUTH)
    expect(res.status).toBe(403)
  })

  it('changes the setup key, so the next turn restarts with every seti tool', async () => {
    const task = await newTask({ seti_control: 'off' })
    await runTurn(task.id, 'first')
    await waitIdle(task.id)
    expect(sdk.fake.last?.options.mcpServers?.seti).toMatchObject({ type: 'sdk', name: 'seti' })
    expect(sessionTools(task).map((entry) => entry.name)).toEqual(['set_status', 'send_file'])
    const before = await setupKey(task)
    await setTaskSetiControl(task, 'full')
    const on = await tasks.get(task.id)
    expect(on && (await setupKey(on))).not.toBe(before)
    const sessions = sdk.fake.sessions.length
    await runTurn(task.id, 'second')
    await waitIdle(task.id)
    expect(sdk.fake.sessions).toHaveLength(sessions + 1)
    expect(sdk.fake.last?.options.mcpServers?.seti).toMatchObject({ type: 'sdk', name: 'seti' })
    expect(on && sessionTools(on)).toHaveLength(SETI_TOOLS.length + 3)
  })

  it('tells the agent at its next turn that its seti tools came or went', async () => {
    const task = await newTask({ seti_control: 'off' })
    await runTurn(task.id, 'first')
    await waitIdle(task.id)
    expect((await request('PATCH', `/tasks/${task.id}`, { seti_control: 'full' })).status).toBe(200)
    const notes = (await messages.page(task.id, 5)).messages.filter((row) => row.kind === 'seti')
    expect(notes.map((row) => row.payload)).toEqual([
      { error: 'Seti control set to Full', seti_control: 'full', seti_control_was: 'off' },
    ])
    await runTurn(task.id, 'second')
    await waitIdle(task.id)
    expect(sdk.fake.prompts.at(-1)).toContain('Seti control is now Full: load the mcp__seti__* tools')
    expect(sdk.fake.prompts.at(-1)).toContain('second')
    await runTurn(task.id, 'third')
    await waitIdle(task.id)
    expect(sdk.fake.prompts.at(-1)).toBe('third')
    expect((await request('PATCH', `/tasks/${task.id}`, { seti_control: 'self' })).status).toBe(200)
    expect((await setiControlPreface(task.id))?.text).toContain('tools that reach past you refuse calls')
    await runTurn(task.id, 'fourth')
    await waitIdle(task.id)
    expect(sdk.fake.prompts.at(-1)).toContain('Seti control is now Self: your mcp__seti__* tools')
    expect((await request('PATCH', `/tasks/${task.id}`, { seti_control: 'off' })).status).toBe(200)
    expect((await setiControlPreface(task.id))?.text).toContain('beyond set_status and send_file refuse calls')
    await runTurn(task.id, 'fifth')
    await waitIdle(task.id)
    expect(sdk.fake.prompts.at(-1)).toContain('Seti control is now off: of the mcp__seti__* tools only')
  })

  it('says nothing when Seti control was set back before the next turn', async () => {
    const task = await newTask()
    await request('PATCH', `/tasks/${task.id}`, { seti_control: 'full' })
    await request('PATCH', `/tasks/${task.id}`, { seti_control: 'off' })
    expect((await setiControlPreface(task.id))?.text).toContain('Seti control is now off')
    await request('PATCH', `/tasks/${task.id}`, { seti_control: 'self' })
    expect(await setiControlPreface(task.id)).toBeNull()
  })

  it('adds a line to the system prompt by level and changes the guide only at Full', async () => {
    const off = await newTask({ seti_control: 'off' })
    const own = await newTask()
    const on = await newTask({ seti_control: 'full' })
    expect(await setiToolsContext(off.id)).toBeNull()
    expect(await setiToolsContext(own.id)).toContain('Your Seti control is Self')
    expect(await setiToolsContext(on.id)).toContain('You have Seti control')
    expect(renderGuide({ mode: 'wake' })).toContain('- Ask @ea for Seti changes outside your task')
    expect(renderGuide({ mode: 'wake', setiTools: true })).toContain('with your seti tools')
    expect(renderGuide({ mode: 'wake', setiTools: true })).not.toContain('Ask @ea')
  })
})

describe('seti tools', () => {
  it('refuse an agent whose Seti control is off', async () => {
    const caller = await newTask({ seti_control: 'off' })
    const result = await call(caller, 'list_tasks', {})
    expect(result).toMatchObject({ isError: true })
    expect(result.text).toContain('Seti control is off')
  })

  it('message another agent directly in the group chat, audited with the agent as actor', async () => {
    const caller = await newTask({ seti_control: 'full' })
    const target = await newTask()
    const listed = await call(caller, 'list_tasks', {})
    expect(listed.text).toContain(target.title)
    const { handle } = await ensureMember(target)
    const sent = await call(caller, 'post_team_chat', { to: `@${handle}`, text: 'Please rebase' })
    expect(sent.isError).toBe(false)
    await waitIdle(target.id)
    expect(sdk.fake.prompts.join('\n')).toContain('No message from the user came with these updates')
    expect(sdk.fake.prompts.join('\n')).toContain('kind="direct"')
    const [event] = (await auditEvents.page(auditQuery.parse({ kind: 'team.direct_posted', limit: 1 }))).events
    expect(event).toMatchObject({
      actor: 'agent',
      subject_id: caller.id,
      detail: { to: `@${handle}`, length: 13 },
    })
    expect(JSON.stringify(event)).not.toContain('Please rebase')
  })

  it('never writes into another agent conversation as the user', async () => {
    const caller = await newTask({ seti_control: 'full' })
    const target = await newTask()
    const asCaller = async <T>(work: () => Promise<T>) => asAgent(caller, work)
    await expect(asCaller(async () => sendTaskMessage(target.id, { prompt: 'hi' }))).rejects.toThrow(PROMPT_AS_USER)
    expect(SETI_TOOLS.map((entry) => entry.name)).not.toContain('send_to_task')
  })

  it("retry another agent's turn with the user's own last message, audited as the caller", async () => {
    const caller = await newTask({ seti_control: 'full' })
    const target = await newTask()
    const empty = await call(caller, 'retry_agent_turn', { task: target.id })
    expect(empty).toMatchObject({ isError: true })
    expect(empty.text).toContain('no message to send again')
    await runTurn(target.id, 'Run the migration')
    await waitIdle(target.id)
    expect((await call(caller, 'retry_agent_turn', { task: target.id, prompt: 'Drop the table' })).isError).toBe(false)
    await waitIdle(target.id)
    const sent = (await messages.page(target.id, 100)).messages.flatMap((row) =>
      row.kind === 'prompt' ? [row.payload] : [],
    )
    expect(sent).toEqual([{ text: 'Run the migration' }, { text: 'Run the migration', retry: true }])
    expect(sdk.fake.prompts.join('\n')).not.toContain('Drop the table')
    const [event] = (await auditEvents.page(auditQuery.parse({ kind: 'task.message_sent', limit: 1 }))).events
    expect(event).toMatchObject({
      actor: 'agent',
      subject_id: target.id,
      detail: { prompt: 'Run the migration', retry: true, agent_id: caller.id },
    })
    const held = await newTask()
    await expect(asAgent(held, async () => retryTask(target.id))).rejects.toThrow('At Seti control Self')
  })

  it('colour another agent with a hex, a preset or an everyday name, and clear it with null', async () => {
    const caller = await newTask({ seti_control: 'full' })
    const target = await newTask()
    const paint = async (color: string | null) => call(caller, 'set_agent_color', { task: target.id, color })
    for (const [sent, kept] of [
      ['#38F', '#3388ff'],
      ['teal', '#3baca6'],
      ['Light  Blue', '#37a4d5'],
      ['purple', '#b066da'],
    ] as const) {
      expect((await paint(sent)).isError, sent).toBe(false)
      expect(await tasks.get(target.id)).toMatchObject({ color: kept })
    }
    const refused = await paint('sunset')
    expect(refused).toMatchObject({ isError: true })
    expect(refused.text).toContain('sunset is not a colour Seti knows')
    expect((await paint(null)).isError).toBe(false)
    expect(await tasks.get(target.id)).toMatchObject({ color: null })
  })

  it.each([
    ['stop_task', {}, 'You cannot stop yourself'],
    ['archive_agent', {}, 'You cannot archive yourself'],
    ['delete_agent', {}, 'You cannot delete yourself'],
    ['restart_agent_session', {}, 'You cannot restart yourself'],
    ['retry_agent_turn', {}, 'You cannot retry the turn of yourself'],
    ['stop_background_work', {}, 'You cannot end the background work of yourself'],
    ['rewind_agent', { prompt: 'x' }, 'You cannot rewind yourself'],
  ])('refuse %s on the calling agent itself', async (name, args, refusal) => {
    const caller = await newTask({ seti_control: 'full' })
    const result = await call(caller, name, { task: caller.id, ...args })
    expect(result).toMatchObject({ isError: true })
    expect(result.text).toContain(refusal)
    expect(await tasks.get(caller.id)).toMatchObject({ archived_at: null })
  })

  it('offer no tool for access, sandbox, credentials, SSH, secrets, memory or CPU caps or Seti control', () => {
    const names = SETI_TOOLS.map((entry) => entry.name)
    for (const name of ['set_agent_access', 'set_agent_profile', 'set_memory_cap', 'set_mcp_default']) {
      expect(names).not.toContain(name)
    }
    expect(names.filter((name) => /sandbox|^set_secret|ssh_key|seti_control|credential/.test(name))).toEqual([])
  })
})

describe('security settings refuse agents in the core functions', () => {
  it.each([
    ['sandbox', async (t: Task) => setTaskSandbox(t, false), "Agents cannot change an agent's sandbox"],
    ['Seti control', async (t: Task) => setTaskSetiControl(t, 'off'), "Agents cannot change an agent's Seti control"],
    ['credentials', async (t: Task) => setTaskProfile(t, 'other'), "Agents cannot change an agent's credentials"],
    [
      'access',
      async (t: Task) => setTaskAccess(t, { kind: 'aws', id: 'aws', enabled: true }),
      "Agents cannot change an agent's access",
    ],
    ['access defaults', async () => setAccessDefault('aws', 'aws', true), 'Agents cannot change what agents get'],
    ['memory cap', async (t: Task) => setTaskMemoryCap(t, null), "Agents cannot change an agent's memory cap"],
    [
      'default memory cap',
      async () => updateMemoryCap({ high_mb: 1024, max_mb: 2048, swap_max_mb: 0 }),
      'Agents cannot change the memory cap of agents',
    ],
    ['CPU cap', async (t: Task) => setTaskCpuCap(t, null), "Agents cannot change an agent's CPU cap"],
    ['default CPU cap', async () => updateCpuCap({ quota_percent: 100 }), 'Agents cannot change the CPU cap of agents'],
  ])('%s', async (_label, change, refusal) => {
    const caller = await newTask({ seti_control: 'full' })
    await expect(asAgent(caller, async () => change(caller))).rejects.toThrow(refusal)
  })
})

describe('start_task', () => {
  it('starts an agent with at most the caller access and Seti control Self', async () => {
    await sshHostStore.insert('cap-host', {
      hostname: '198.51.100.20',
      port: 22,
      user: 'ops',
      key_id: null,
      jump: null,
      options: [],
    })
    await accessDefaults.set('ssh', 'cap-host', true)
    await accessDefaults.set('aws', 'aws', true)
    const caller = await newTask({ seti_control: 'full' })
    await taskAccess.set(caller.id, 'ssh', 'cap-host', false)
    await taskAccess.set(caller.id, 'aws', 'aws', false)
    setPlannerModel(async () => Promise.resolve({ title: 'Child agent', ssh_hosts: ['cap-host'], aws: true }))
    const result = await call(caller, 'start_task', { prompt: 'ssh to cap-host and check aws' })
    expect(result.isError).toBe(false)
    const { id } = JSON.parse(result.text) as { id: string }
    await waitIdle(id)
    const child = await tasks.get(id)
    expect(child).toMatchObject({ sandbox: true, seti_control: 'self', profile_id: caller.profile_id })
    expect(await taskAccess.all(id, 'ssh')).toEqual({ 'cap-host': false })
    expect(await taskAccess.all(id, 'aws')).toEqual({ aws: false })
    expect(child?.setup?.withheld).toEqual(
      expect.arrayContaining([`SSH cap-host: beyond what ${caller.title} has`, `AWS: beyond what ${caller.title} has`]),
    )
    const [created] = (await auditEvents.page(auditQuery.parse({ kind: 'task.created', limit: 1 }))).events
    expect(created).toMatchObject({ actor: 'agent', subject_id: id, detail: { agent_id: caller.id } })
    await accessDefaults.set('ssh', 'cap-host', false)
    await accessDefaults.set('aws', 'aws', false)
  })
})
