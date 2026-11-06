import { randomUUID } from 'node:crypto'
import { auditQuery, channelCreateInput, type SetiControlLevel, type Task } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { asAgent } from '../access.js'
import { createApp } from '../app.js'
import { EVERY_AGENT, ON_ONE_AGENT, READS_SETI, toolsFor } from './levels.js'
import { createChannel, subscribeChannel } from '../channels/actions.js'
import { createPack } from '../context-changes.js'
import { tasks } from '../db.js'
import { runModAction } from '../mods/commands.js'
import { askAside } from '../side-chat/ask.js'
import { auditEvents } from '../store/audit.js'
import { updateTask } from '../task-actions.js'
import { linkTaskPr } from '../tasks.js'
import { SETI_TOOLS } from './catalog.js'
import { REQUEST_TOOLS } from './requests.js'
import { callSetiTool, sessionTools } from './server.js'
import { withBundledMods } from '../test-mods.js'

createApp()
withBundledMods()

async function newTask(level?: SetiControlLevel): Promise<Task> {
  const id = randomUUID()
  await tasks.insert({
    id,
    title: `Self ${id.slice(0, 8)}`,
    repo_id: null,
    cwd: '/tmp',
    worktree: false,
    pr_urls: [],
    ...(level === undefined ? {} : { seti_control: level }),
  })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('task was not stored')
  }
  return task
}

function fullTool(name: string) {
  const found = SETI_TOOLS.find((entry) => entry.name === name)
  if (!found) {
    throw new Error(`no seti tool ${name}`)
  }
  return found
}

async function call(caller: Task, name: string, args: unknown) {
  const result = await callSetiTool(fullTool(name), caller.id, args)
  return { text: result.content.map((block) => block.text).join(''), isError: 'isError' in result }
}

const OUTSIDE = 'At Seti control Self your seti tools act only on you'

describe('the Self level', () => {
  it('is what a new agent gets, with tools that read Seti and act on the agent', async () => {
    const task = await newTask()
    expect(task.seti_control).toBe('self')
    const names = sessionTools(task).map((entry) => entry.name)
    expect(names).toEqual(
      expect.arrayContaining([...EVERY_AGENT.map((e) => e.name), ...Object.keys(ON_ONE_AGENT), ...READS_SETI]),
    )
    const own = Object.keys(ON_ONE_AGENT).length + READS_SETI.length
    expect(names).toHaveLength(EVERY_AGENT.length + REQUEST_TOOLS.length + own)
    expect(names).toContain('request_change')
    for (const name of ['start_task', 'post_team_chat', 'list_tasks', 'stop_task', 'create_channel', 'add_repo']) {
      expect(names).not.toContain(name)
    }
  })

  it('takes no argument naming an agent in the tools that act on one', () => {
    const self = new Map(toolsFor('self').map((entry) => [entry.name, entry]))
    for (const [name, key] of Object.entries(ON_ONE_AGENT)) {
      expect(fullTool(name).input, name).toHaveProperty(key)
      expect(self.get(name)?.input, name).not.toHaveProperty(key)
    }
    for (const name of READS_SETI) {
      expect(self.get(name), name).toBe(fullTool(name))
    }
    expect(self.get('get_task')?.description).toMatch(/linked PRs\. For an earlier day use read_transcript\. At Seti/)
  })

  it('never asks another agent a side question', async () => {
    const caller = await newTask()
    const other = await newTask()
    expect(toolsFor('self').map((entry) => entry.name)).not.toContain('mod_side-chat_ask')
    expect(toolsFor('full').map((entry) => entry.name)).toContain('mod_side-chat_ask')
    const args = { task: other.id, question: 'What did you find?' }
    await expect(asAgent(caller, async () => runModAction('side-chat', 'ask', args))).rejects.toThrow(/Self/)
    await expect(asAgent(caller, async () => askAside(other.id, 'What did you find?', false))).rejects.toThrow(OUTSIDE)
  })

  it('refuses a tool beyond Self at the time of the call, whatever the session loaded', async () => {
    const caller = await newTask('full')
    const target = await newTask()
    await tasks.setSetiControl(caller.id, 'self')
    const sent = await call(caller, 'stop_task', { task: target.id })
    expect(sent).toMatchObject({ isError: true })
    expect(sent.text).toContain('stop_task reaches past you, and your Seti control is Self')
  })

  it('acts on the caller whatever agent a call names', async () => {
    const caller = await newTask()
    const other = await newTask()
    expect((await call(caller, 'set_agent_color', { task: other.id, color: 'teal' })).isError).toBe(false)
    expect(await tasks.get(caller.id)).toMatchObject({ color: '#3baca6' })
    expect((await tasks.get(other.id))?.color).toBe(other.color)
    expect((await call(caller, 'rename_agent', { title: 'Renamed by itself' })).isError).toBe(false)
    const [event] = (await auditEvents.page(auditQuery.parse({ kind: 'task.renamed', limit: 1 }))).events
    expect(event).toMatchObject({ actor: 'agent', subject_id: caller.id, detail: { agent_id: caller.id } })
  })

  it('refuses a reference to another agent without naming the agents that exist', async () => {
    const caller = await newTask()
    const other = await newTask()
    const result = await call(caller, 'get_memory_cap', { agent: other.title })
    expect(result).toMatchObject({ isError: true })
    expect(result.text).toContain(OUTSIDE)
    expect(result.text).not.toContain(other.id)
    expect((await call(caller, 'get_memory_cap', { agent: caller.id })).isError).toBe(false)
  })

  it('refuses creating a shared role pack through set_agent_role', async () => {
    const caller = await newTask()
    const result = await call(caller, 'set_agent_role', { text: 'Review only.' })
    expect(result).toMatchObject({ isError: true })
    expect(result.text).toContain('Below Seti control Full you cannot create context packs')
  })
})

describe('the core functions refuse a Self agent', () => {
  it('on another agent and on what every agent shares, and let it act on itself', async () => {
    const caller = await newTask()
    const other = await newTask()
    const { channel } = await createChannel(channelCreateInput.parse({ name: `self-${caller.id}`, preset: 'generic' }))
    const asCaller = async <T>(fn: () => Promise<T>) => asAgent(caller, fn)
    await expect(asCaller(async () => updateTask(other.id, { title: 'x' }))).rejects.toThrow(OUTSIDE)
    await expect(asCaller(async () => linkTaskPr(other.id, 'https://github.com/o/r/pull/1'))).rejects.toThrow(OUTSIDE)
    await expect(
      asCaller(async () => subscribeChannel(channel.id, { target: 'task', task_id: other.id, events: null })),
    ).rejects.toThrow(OUTSIDE)
    await expect(
      asCaller(async () => subscribeChannel(channel.id, { target: 'ea', events: null, mode: 'report' })),
    ).rejects.toThrow("Below Seti control Full you cannot subscribe the EA's inbox")
    await expect(asCaller(async () => createPack({ name: 'Shared', description: '', body: 'x' }))).rejects.toThrow(
      'Below Seti control Full you cannot create context packs',
    )
    expect((await asCaller(async () => updateTask(caller.id, { title: 'Still me' }))).title).toBe('Still me')
    const full = { ...caller, seti_control: 'full' as const }
    expect((await asAgent(full, async () => updateTask(other.id, { pinned: true }))).pinned).toBe(true)
  })
})
