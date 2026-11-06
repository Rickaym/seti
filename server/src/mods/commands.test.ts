import { randomUUID } from 'node:crypto'
import { modManifest, type ModActionResult, type SetiControlLevel, type Task } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asAgent, asMod } from '../access.js'
import { createApp } from '../app.js'
import { tasks } from '../db.js'
import { eaPackPrompt } from '../seti-guide.js'
import { callSetiTool, sessionTools } from '../seti-tools/server.js'
import { auditEvents } from '../store/audit.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { modHost } from './bundled.js'
import { runModAction, slashRefusal } from './commands.js'

const app = createApp()

const post = async (route: string, body: unknown, auth: Record<string, string> = USER_AUTH) =>
  app.request(`/api${route}`, {
    method: 'POST',
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

async function newTask(level: SetiControlLevel): Promise<Task> {
  const id = randomUUID()
  const title = `Mods ${id.slice(0, 8)}`
  await tasks.insert({ id, title, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [], seti_control: level })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('task was not stored')
  }
  return task
}

async function callTool(caller: Task, name: string, args: unknown) {
  const tool = sessionTools(caller).find((entry) => entry.name === name)
  if (tool === undefined) {
    throw new Error(`no tool ${name}`)
  }
  const result = await callSetiTool(tool, caller.id, args)
  return { text: result.content.map((block) => block.text).join(''), isError: 'isError' in result }
}

beforeAll(async () => {
  await modHost.setEnabled('sample', true)
})

afterAll(async () => {
  await modHost.setEnabled('sample', false)
})

describe('mod commands', () => {
  it('run from the palette as the user, audited as the user', async () => {
    const res = await post('/mods/sample/actions/count', { args: {} })
    expect(res.status, await res.clone().text()).toBe(200)
    const { data } = (await res.json()) as { data: ModActionResult }
    expect(data.text).toMatch(/^The sample counted to \d+$/)
    expect(await auditEvents.latest('mod.action_run')).toMatchObject({
      actor: 'user',
      summary: 'Ran Count of the Sample mod',
      detail: { mod: 'sample', action: 'count', args: [] },
    })
  })

  it('run for the EA, resolving the agent by its title', async () => {
    const task = await newTask('self')
    const res = await post('/mods/sample/actions/wave', { args: { task: task.title, note: 'hi' } }, EA_AUTH)
    expect(res.status, await res.clone().text()).toBe(200)
    const { data } = (await res.json()) as { data: ModActionResult }
    expect(data.text).toBe(`The sample waved at ${task.id} for the ea: hi`)
  })

  it('refuse arguments the manifest does not declare, and a mod that runs commands', async () => {
    expect((await post('/mods/sample/actions/count', { args: { loud: true } })).status).toBe(400)
    await expect(asMod({ id: 'sample', grants: [] }, async () => runModAction('sample', 'count', {}))).rejects.toThrow(
      'Mods cannot run mod commands',
    )
  })

  it('give a Full agent every tool and a Self agent only the ones that act on itself', async () => {
    const full = await newTask('full')
    const self = await newTask('self')
    const names = (task: Task) => sessionTools(task).map((entry) => entry.name)
    expect(names(full)).toEqual(expect.arrayContaining(['mod_sample_count', 'mod_sample_wave']))
    expect(names(self)).toContain('mod_sample_wave')
    expect(names(self)).not.toContain('mod_sample_count')
    expect(await callTool(full, 'mod_sample_count', {})).toMatchObject({ isError: false })
    expect((await callTool(full, 'mod_sample_wave', { task: self.id })).text).toContain(
      `waved at ${self.id} for the agent`,
    )
    const own = await callTool(self, 'mod_sample_wave', { note: 'me' })
    expect(own.text).toContain(`waved at ${self.id} for the agent: me`)
    await expect(asAgent(self, async () => runModAction('sample', 'wave', { task: full.id }))).rejects.toThrow(
      /act only on you/,
    )
    await expect(asAgent(self, async () => runModAction('sample', 'count', {}))).rejects.toThrow(/Self/)
  })

  it('list the EA actions in its prompt while the mod is on, and say a turned-off mod is off', async () => {
    expect((await eaPackPrompt()).mod_actions).toContain('- sample count (Sample): "Count".')
    await modHost.setEnabled('sample', false)
    try {
      expect((await eaPackPrompt()).mod_actions).toBe('')
      const res = await post('/mods/sample/actions/count', { args: {} })
      expect(res.status).toBe(409)
      expect(await res.text()).toContain('Sample is off')
      expect(slashRefusal('/sample hello')).toBe(
        '/sample belongs to Sample, which is off; turn it on in Settings, Mods',
      )
      const full = await newTask('full')
      expect(sessionTools(full).map((entry) => entry.name)).not.toContain('mod_sample_count')
    } finally {
      await modHost.setEnabled('sample', true)
    }
    expect(slashRefusal('/sample hello')).toContain('never goes to the agent')
  })
})

describe('the commands point in a manifest', () => {
  const manifest = (commands: unknown[], extra: Record<string, unknown> = {}) =>
    modManifest.safeParse({
      id: 'probe',
      name: 'Probe',
      version: '1.0.0',
      seti: '^1.3',
      description: 'A mod the tests build',
      contributes: { commands, ...extra },
    })

  it('needs a task argument for a self command, and no required argument for the palette', () => {
    expect(manifest([{ id: 'go', title: 'Go', for: ['agents'], level: 'self' }]).success).toBe(false)
    const asks = { id: 'go', title: 'Go', for: ['palette'], args: { text: { type: 'string' } } }
    expect(manifest([asks]).success).toBe(false)
    expect(manifest([{ ...asks, for: ['ea'] }]).success).toBe(true)
  })

  it('keeps agent tool names valid and slash commands on commands that take their text', () => {
    const long = { id: 'a'.repeat(40), title: 'Long', for: ['agents'] }
    expect(manifest([long]).success).toBe(true)
    const tooLong = modManifest.safeParse({
      id: 'b'.repeat(30),
      name: 'Probe',
      version: '1.0.0',
      seti: '^1.3',
      description: 'A mod the tests build',
      contributes: { commands: [long] },
    })
    expect(tooLong.success).toBe(false)
    const two = { id: 'go', title: 'Go', for: ['ea'], args: { a: { type: 'string' }, b: { type: 'string' } } }
    expect(manifest([two], { slashCommands: [{ name: 'go', description: 'Go', command: 'go' }] }).success).toBe(false)
    expect(manifest([], { slashCommands: [{ name: 'go', description: 'Go', command: 'gone' }] }).success).toBe(false)
  })
})
