import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { tasks } from '../db.js'
import { SETI_TOOLS } from './catalog.js'
import { callSetiTool } from './server.js'
import { auditEvents } from '../store/audit.js'
import { contextPacks } from '../store/context.js'
import { revisions } from '../store/revisions.js'

const caller = randomUUID()
await tasks.insert({
  id: caller,
  title: 'Pack keeper',
  repo_id: null,
  cwd: '/tmp',
  worktree: false,
  pr_urls: [],
  seti_control: 'full',
})

async function call(name: string, args: object = {}) {
  const entry = SETI_TOOLS.find((tool) => tool.name === name)
  if (entry === undefined) {
    throw new Error(`No seti tool ${name}`)
  }
  const result = await callSetiTool(entry, caller, args)
  const text = result.content.map((block) => block.text).join('')
  return { error: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> }
}

describe('context pack tools', () => {
  it('create, update, read and delete a pack as the agent, with its changes flagged for the user', async () => {
    const created = await call('create_context_pack', {
      name: 'Deploy notes',
      description: 'How we deploy',
      body: '# Steps\nRun the release script.',
      reason: 'The user asked for deploy notes',
    })
    expect(created.error).toBe(false)
    const id = String(created.json().id)
    expect(await auditEvents.latest('seti.context_pack_created')).toMatchObject({ actor: 'agent', subject_id: id })

    expect((await call('update_context_pack', { pack: 'Deploy notes', append: 'Then tag it.' })).error).toBe(false)
    expect((await contextPacks.get(id))?.body).toBe('# Steps\nRun the release script.\n\nThen tag it.\n')
    expect(await auditEvents.latest('seti.context_pack_updated')).toMatchObject({ actor: 'agent', subject_id: id })

    expect((await call('get_context_pack', { pack: id, query: 'tag' })).json().matches).toEqual(['Then tag it.'])
    expect((await revisions.unseen()).some((change) => change.object_id === id)).toBe(true)
    const changes = await call('list_changes', { pack: 'Deploy notes' })
    expect(changes.json()).toHaveLength(2)

    expect((await call('mark_changes_seen', { pack: id })).error).toBe(false)
    expect((await revisions.unseen()).some((change) => change.object_id === id)).toBe(false)

    expect((await call('delete_context_pack', { pack: 'Deploy notes' })).error).toBe(false)
    expect(await contextPacks.get(id)).toBeUndefined()
    expect(await auditEvents.latest('context.pack_deleted')).toMatchObject({
      actor: 'agent',
      detail: expect.objectContaining({ via: 'seti_tools', agent_id: caller }) as unknown,
    })
  })

  it('refuses to change or delete the built-in guide', async () => {
    const guide = (await contextPacks.list()).find((pack) => pack.builtin && pack.kind === 'reference')
    expect(guide).toBeDefined()
    const refused = await call('delete_context_pack', { pack: guide?.id ?? '' })
    expect(refused).toMatchObject({ error: true })
    expect(refused.text).toContain('built into Seti')
  })

  it('reverts the latest change to a pack', async () => {
    const id = String((await call('create_context_pack', { name: 'Revert me', body: 'one' })).json().id)
    await call('update_context_pack', { pack: id, body: 'two' })
    expect((await call('revert_change', { pack: id })).error).toBe(false)
    expect((await contextPacks.get(id))?.body).toBe('one')
  })
})

describe('context file tools', () => {
  it('writes the user-level CLAUDE.md as the agent and reads it back', async () => {
    const written = await call('write_context_file', { file: 'user', content: '# Rules\nBe brief.' })
    expect(written.error).toBe(false)
    expect((await call('write_context_file', { file: 'user', append: 'Say why.' })).error).toBe(false)
    const read = await call('read_context_file', { file: 'user', full: true })
    expect(read.json().content).toBe('# Rules\nBe brief.\n\nSay why.\n')
    expect(await auditEvents.latest('seti.context_file_saved')).toMatchObject({ actor: 'agent', subject_id: 'user' })
    const files = (await call('list_context_files')).json() as unknown as { key: string; exists: boolean }[]
    expect(files.find((file) => file.key === 'user')?.exists).toBe(true)
  })

  it('refuses a write that changes nothing', async () => {
    await call('write_context_file', { file: 'user', content: 'Same.' })
    const again = await call('write_context_file', { file: 'user', content: 'Same.' })
    expect(again).toMatchObject({ error: true })
    expect(again.text).toContain('already says that')
  })
})
