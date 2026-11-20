import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { tasks } from './db.js'
import { inProcessDecisions } from './session-decisions.js'
import { realiseSpec } from './session-realise.js'
import { sessionSpec, setupKey } from './session-spec.js'

createApp()

async function newTask(id: string, sandbox: boolean) {
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, sandbox, pr_urls: [] })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('no task')
  }
  return task
}

/** What survives a trip through JSON, leaving out in-process server instances the node makes. */
const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (key, field: unknown) => (key === 'instance' ? undefined : field)))

describe('a session spec', () => {
  it('is plain data that realises to the same options after a trip through JSON', async () => {
    for (const sandboxed of [false, true]) {
      const task = await newTask(`spec-plain-${String(sandboxed)}`, sandboxed)
      const { spec } = await sessionSpec(task)
      const copy = plain(spec) as typeof spec
      expect(copy).toEqual(spec)
      const direct = await realiseSpec(spec, new AbortController(), inProcessDecisions)
      const sent = await realiseSpec(copy, new AbortController(), inProcessDecisions)
      expect(plain(sent)).toEqual(plain(direct))
      expect(Object.keys(sent.hooks ?? {})).toEqual(Object.keys(direct.hooks ?? {}))
      expect(typeof sent.canUseTool).toBe('function')
    }
  })

  it('carries the key of the setup it was built from', async () => {
    const task = await newTask('spec-key', false)
    const { key } = await sessionSpec(task)
    expect(key).toBe(await setupKey(task))
  })
})
