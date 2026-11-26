import { randomUUID } from 'node:crypto'
import { AWS_ACCESS_ID, type MessageRow, type Task } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { messages, tasks } from './db.js'
import { profiles } from './store/credentials.js'
import { USER_AUTH } from './test-auth.js'

await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-setting-notes-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
})

const app = createApp({ access: null, verify: null })
const HEADERS = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }

async function seedTask(): Promise<Task> {
  const id = `notes-${randomUUID().slice(0, 8)}`
  await tasks.insert({ id, title: 'Notes', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('the task was not stored')
  }
  return task
}

const send = async (method: string, path: string, body: unknown) =>
  app.request(`/api${path}`, { method, headers: HEADERS, body: JSON.stringify(body) })

async function notes(taskId: string) {
  const rows = (await messages.page(taskId, 20)).messages
  return rows.flatMap((row: MessageRow) => (row.kind === 'seti' ? [row.payload] : []))
}

describe('a note in the transcript for each change to what an agent may reach', () => {
  it('says when the sandbox, the credentials and an access item change, from any surface', async () => {
    const task = await seedTask()
    expect((await send('PATCH', `/tasks/${task.id}`, { sandbox: false })).status).toBe(200)
    const ops = await profiles.create(`Ops ${randomUUID().slice(0, 6)}`)
    expect((await send('PATCH', `/tasks/${task.id}`, { profile_id: ops.id })).status).toBe(200)
    expect(
      (await send('PUT', `/tasks/${task.id}/access`, { kind: 'aws', id: AWS_ACCESS_ID, enabled: true })).status,
    ).toBe(200)
    const written = await notes(task.id)
    expect(written.map((note) => note.setting)).toEqual(['sandbox', 'credential', 'access'])
    expect(written[0]?.error).toBe("Sandbox off from the next turn: the agent uses this machine's own access")
    expect(written[1]?.error).toBe(`Credentials ${ops.name} from the next turn`)
    expect(written[2]?.error).toMatch(/^Turned on AWS .*from the next turn$/)
  })

  it('writes nothing when a change changes nothing', async () => {
    const task = await seedTask()
    expect((await send('PATCH', `/tasks/${task.id}`, { sandbox: task.sandbox })).status).toBe(200)
    expect(await notes(task.id)).toEqual([])
  })
})
