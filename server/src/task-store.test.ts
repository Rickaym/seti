import { AGENT_COLOR_PRESETS } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { sql, tasks } from './db.js'
import { migrate } from './pg.js'

const FIRST_PR = 'https://github.com/acme/app/pull/3'

beforeAll(async () => {
  await tasks.insert({
    id: 'stored-task',
    title: 'Stored',
    repo_id: null,
    cwd: '/tmp',
    worktree: false,
    pr_urls: [FIRST_PR],
  })
  await tasks.insert({ id: 'stored-plain', title: 'Plain', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
})

describe('task store', () => {
  it('applies no migration twice', async () => {
    expect(await migrate(sql)).toEqual([])
  })

  it('marks running tasks interrupted and unseen, and leaves the rest', async () => {
    await tasks.setStatus('stored-task', 'running', null)
    await tasks.markInterrupted()
    expect(await tasks.get('stored-task')).toMatchObject({
      title: 'Stored',
      source_session_id: null,
      status: 'interrupted',
      input_mode: 'wake',
      unseen: true,
    })
    expect(await tasks.get('stored-plain')).toMatchObject({ status: 'idle', unseen: false })
  })

  it('stores the PRs a task starts with as linked by the user', async () => {
    expect(await sql`SELECT task_id, pr_url, source FROM task_pr WHERE task_id = 'stored-task'`).toEqual([
      { task_id: 'stored-task', pr_url: FIRST_PR, source: 'user' },
    ])
    expect((await tasks.get('stored-task'))?.pr_urls).toEqual([FIRST_PR])
    expect((await tasks.get('stored-plain'))?.pr_urls).toEqual([])
  })

  it('links many PRs per task in link order, once each, and drops them with the task', async () => {
    const second = 'https://github.com/acme/api/pull/9'
    expect(await tasks.linkPr('stored-task', second, 'agent')).toBe(true)
    expect(await tasks.linkPr('stored-task', second, 'user')).toBe(false)
    expect((await tasks.get('stored-task'))?.pr_urls).toEqual([FIRST_PR, second])
    expect(await tasks.unlinkPr('stored-task', FIRST_PR)).toBe(true)
    expect(await tasks.unlinkPr('stored-task', FIRST_PR)).toBe(false)
    expect((await tasks.get('stored-task'))?.pr_urls).toEqual([second])
    await tasks.remove('stored-task')
    expect(await sql`SELECT * FROM task_pr WHERE task_id = 'stored-task'`).toEqual([])
  })

  it('allows one task per source session and any number without one', async () => {
    const base = { title: 'Imported', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] }
    await tasks.insertImported({ ...base, id: 'a', session_id: 'fork-a', source_session_id: 'source' }, [])
    await expect(
      tasks.insertImported({ ...base, id: 'b', session_id: 'fork-b', source_session_id: 'source' }, []),
    ).rejects.toMatchObject({ code: '23505' })
    expect(await tasks.get('b')).toBeUndefined()
    await tasks.insert({ ...base, id: 'c' })
    await tasks.insert({ ...base, id: 'd' })
    expect((await tasks.list()).filter((t) => t.source_session_id === null)).toHaveLength(3)
    await tasks.insert({ ...base, id: 'e', pr_urls: ['https://github.com/acme/app/pull/5'] })
    expect(await sql`SELECT source FROM task_pr WHERE task_id = 'e'`).toEqual([{ source: 'user' }])
  })

  it('gives each new task a preset the agents that are not archived use least', async () => {
    const base = { title: 'Painted', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] }
    const [red, ...rest] = AGENT_COLOR_PRESETS.map((preset) => preset.hex)
    const teal = AGENT_COLOR_PRESETS.find((preset) => preset.name === 'teal')?.hex
    await sql`UPDATE task SET color = ${red ?? null} WHERE archived_at IS NULL`
    for (const color of rest) {
      const id = `paint-${color}`
      await tasks.insert({ ...base, id })
      await tasks.setColor(id, color)
    }
    await sql`UPDATE task SET archived_at = ${new Date().toISOString()} WHERE color = ${teal ?? null}`
    await tasks.insert({ ...base, id: 'paint-new' })
    expect(await tasks.get('paint-new')).toMatchObject({ color: teal })
    await tasks.insertImported({ ...base, id: 'paint-imported', session_id: 'fork-p', source_session_id: 'p' }, [])
    expect(rest).toContain((await tasks.get('paint-imported'))?.color)
  })
})
