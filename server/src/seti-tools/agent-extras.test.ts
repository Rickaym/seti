import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tasks } from '../db.js'
import { SETI_TOOLS } from './catalog.js'
import { callSetiTool } from './server.js'

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-extras-'))
const caller = { id: randomUUID(), title: 'Extras reader', seti_control: 'full' as const }
const target = { id: randomUUID(), title: 'Extras target', seti_control: 'self' as const }
for (const task of [caller, target]) {
  await tasks.insert({ ...task, repo_id: null, cwd, worktree: false, pr_urls: [] })
}

async function call(name: string, args: object) {
  const entry = SETI_TOOLS.find((tool) => tool.name === name)
  if (entry === undefined) {
    throw new Error(`No seti tool ${name}`)
  }
  const result = await callSetiTool(entry, caller.id, args)
  const text = result.content.map((block) => block.text).join('')
  return { error: result.isError === true, text }
}

describe("an agent's extras for the other agents' tools", () => {
  it('reads what second opinions cost, and the files an agent changed', async () => {
    const detail = JSON.parse((await call('get_task', { task: target.id })).text) as Record<string, unknown>
    expect(detail.second_opinions).toEqual({ spend: [], reviews: [] })
    fs.writeFileSync(path.join(cwd, 'notes.md'), 'changed')
    const files = JSON.parse((await call('get_task', { task: target.id, files: true })).text) as {
      files: { path: string }[]
    }
    expect(files.files.map((file) => file.path)).toContain('notes.md')
  })

  it('refuses the output of a shell the agent does not have, and a malformed shell id', async () => {
    expect((await call('list_processes', { task: target.id, shell: 'b123' })).error).toBe(true)
    expect((await call('list_processes', { task: target.id, shell: '../x' })).error).toBe(true)
  })
})

describe("agents' agent_access without an agent", () => {
  it('lists what every agent gets by default at Full', async () => {
    const result = await call('agent_access', {})
    expect(result.error).toBe(false)
    const items = JSON.parse(result.text) as { kind: string; default_enabled: boolean }[]
    expect(items.every((entry) => typeof entry.default_enabled === 'boolean')).toBe(true)
  })
})
