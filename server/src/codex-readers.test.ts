import { eventsOf, rowEvents, type CodexMessage } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { sql } from './db.js'
import { nodeLink } from './node-link.js'
import { pushed } from './pr-self.js'
import recorded from './runtimes/codex/reference-turn.json' with { type: 'json' }
import { taskArchives } from './store/archive.js'
import { eaContextStore } from './store/ea-context.js'
import { prWatch } from './store/pr-watch.js'
import { messageSearch } from './store/search.js'

const ROOT = '01a20244-c954-7390-bda1-b0194900d368'
const AT = '2026-11-24T00:00:00.000Z'
const PR = 'https://github.com/acme/web/pull/41'

beforeAll(() => {
  createApp()
})

async function codexTask(id: string, extra: readonly unknown[] = []): Promise<string> {
  await sql`INSERT INTO task (id, title, cwd, status, runtime, created_at, updated_at)
    VALUES (${id}, ${id}, '/tmp', 'idle', 'codex', ${AT}, ${AT})`
  for (const message of [...recorded, ...extra]) {
    const payload: CodexMessage = { root: ROOT, message }
    await nodeLink.journal(id, { type: 'message', runtime: 'codex', payload })
  }
  return id
}

const search = async (taskId: string, q: string, tools: boolean) =>
  (await messageSearch.search(taskId, { q, mode: 'text', limit: 10, tools })).hits.length

/** A push the agent ran, as Codex reports the command's start. */
const push = {
  method: 'item/started',
  params: {
    threadId: ROOT,
    item: { type: 'commandExecution', id: 'call_push', command: 'git push origin work', status: 'inProgress' },
  },
}

describe('readers of a Codex agent', () => {
  it('find its replies in the conversation, and its commands and their output with tools', async () => {
    const id = await codexTask('codex-search')
    expect(await search(id, 'ran one command', false)).toBe(1)
    expect(await search(id, 'spike-shell-ran', false)).toBe(0)
    expect(await search(id, 'spike-shell-ran', true)).toBe(1)
    expect(await search(id, 'shell-proof.txt', true)).toBeGreaterThan(0)
    expect(await search(id, 'SCENARIO', true)).toBe(0)
  })

  it('keep its rows findable after an archive and a restore', async () => {
    const id = await codexTask('codex-search-restore')
    expect(await taskArchives.archive(id, 'user')).not.toBeNull()
    expect(await taskArchives.restore(id)).not.toBeNull()
    expect(await search(id, 'ran one command', false)).toBe(1)
  })

  it('see the pushes it made among its calls', async () => {
    const id = await codexTask('codex-push', [push])
    await sql`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (${id}, ${PR}, ${AT}, 'manual')`
    expect(pushed(await prWatch.pushCalls(id, PR))).toBe(true)
    const calls = await prWatch.calls(PR, '2000-01-01', '2999-01-01')
    expect(calls.some((row) => row.payload.includes('git push origin work'))).toBe(true)
  })

  it('give the EA its calls without their output', async () => {
    const id = await codexTask('codex-ea')
    const rows = (await eaContextStore.recentActivity([id], 100)).get(id) ?? []
    const ends = rows.flatMap((row) => eventsOf(rowEvents(row), 'tool.ended'))
    expect(ends.map((end) => end.callId)).toContain('call_0004')
    expect(JSON.stringify(rows).includes('README.md\\nshell-proof.txt')).toBe(false)
    expect(rows.every((row) => row.kind === 'sdk' && row.runtime === 'codex')).toBe(true)
  })
})
