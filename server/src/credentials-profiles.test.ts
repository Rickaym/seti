import type { CredentialProfile, CredentialsOverview, ProfileSummary, Task } from '@seti/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { sql, tasks } from './db.js'
import { githubTokens } from './secrets.js'
import { auditEvents } from './store/audit.js'
import { USER_AUTH } from './test-auth.js'
import { migrateWith } from './test-migration.js'

const app = createApp()
const LOCAL = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...USER_AUTH }
const ROLE = 'arn:aws:iam::123456789012:role/seti-agent-readonly'
const GITHUB = `github_pat_${'Pr0f'.repeat(15)}`

async function send(method: string, url: string, body?: unknown) {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { ...LOCAL, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, text: await res.text() }
}

async function data<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await send(method, url, body)
  expect(res.status, res.text).toBe(200)
  return (JSON.parse(res.text) as { data: T }).data
}

let count = 0
async function newTask(profileId = 'default'): Promise<Task> {
  const id = `profile-task-${String(++count)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [], profile_id: profileId })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('Task was not stored')
  }
  return task
}

afterEach(async () => {
  await sql`UPDATE task SET profile_id = 'default'`
  await sql`DELETE FROM credential_profile WHERE id <> 'default'`
  await sql`DELETE FROM secret`
})

describe('the credential profile migration', () => {
  it('turns the AWS role into the Default profile and puts every task on it', async () => {
    const seed = `
      INSERT INTO aws_settings (id, role_arn, external_id, region, session_minutes, updated_at)
        VALUES (1, '${ROLE}', 'ext-7', 'us-east-1', 90, '2026-09-29T10:00:00.000Z');
      INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES ('old', 'Old', '/tmp', 'idle', 'x', 'x');`
    const outcome = await migrateWith('credential_profiles', seed, async (tx) => {
      const rows = await tx`SELECT id, name, aws_role_arn, aws_external_id, aws_region, aws_session_minutes,
        updated_at FROM credential_profile`
      const task = await tx`SELECT profile_id FROM task WHERE id = 'old'`
      const legacy = await tx`SELECT to_regclass('aws_settings') AS still`
      return { rows: [...rows], task: [...task], legacy: [...legacy] }
    })
    expect(outcome).toEqual({
      rows: [
        {
          id: 'default',
          name: 'Default',
          aws_role_arn: ROLE,
          aws_external_id: 'ext-7',
          aws_region: 'us-east-1',
          aws_session_minutes: 90,
          updated_at: '2026-09-29T10:00:00.000Z',
        },
      ],
      task: [{ profile_id: 'default' }],
      legacy: [{ still: null }],
    })
  })

  it('keeps the GitHub tokens of before as the Default profile tokens', async () => {
    await githubTokens('default').setDefault(GITHUB)
    await githubTokens('default').setOwner('octocat', `${GITHUB}owner`)
    const overview = await data<CredentialsOverview>('GET', '/credentials')
    const builtin = overview.profiles.find((profile) => profile.id === 'default')
    expect(builtin?.github.default.configured).toBe(true)
    expect(builtin?.github.owners.map((owner) => owner.owner)).toEqual(['octocat'])
    expect(builtin?.builtin).toBe(true)
  })
})

describe('credential profiles', () => {
  it('creates, renames and deletes a profile, moving its agents to Default and auditing without values', async () => {
    const work = await data<CredentialProfile>('POST', '/credentials/profiles', { name: 'Work' })
    expect(work).toMatchObject({ name: 'Work', builtin: false, connections: [], agents: [] })
    expect((await send('POST', '/credentials/profiles', { name: 'Work' })).status).toBe(409)
    const task = await newTask(work.id)
    await data('PUT', `/credentials/profiles/${work.id}/github/Globex`, { value: GITHUB })
    await data('PUT', `/credentials/profiles/${work.id}/aws`, {
      role_arn: ROLE,
      external_id: 'secret-ish-ext',
      region: 'us-east-1',
      session_minutes: 60,
    })
    const renamed = await data<CredentialProfile>('PATCH', `/credentials/profiles/${work.id}`, { name: 'Client A' })
    expect(renamed).toMatchObject({
      name: 'Client A',
      aws: { role_arn: ROLE },
      github: { owners: [expect.objectContaining({ owner: 'globex' }) as unknown] },
      agents: [{ id: task.id, title: task.title, sandbox: true }],
    })
    expect((await send('PATCH', '/credentials/profiles/default', { name: 'Other' })).status).toBe(409)
    expect((await send('DELETE', '/credentials/profiles/default')).status).toBe(409)
    expect((await send('DELETE', `/credentials/profiles/${work.id}`)).status).toBe(204)
    expect((await tasks.get(task.id))?.profile_id).toBe('default')
    expect(await githubTokens(work.id).status()).toMatchObject({ default: { configured: false }, owners: [] })
    const deleted = await auditEvents.latest('system.profile_deleted')
    expect(deleted).toMatchObject({
      subject_type: 'credential_profile',
      detail: { agents_moved_to_default: [task.title] },
    })
    const page = await send('GET', '/audit?limit=50')
    expect(page.text).toContain('Set the GitHub token for globex of the credential Work')
    expect(page.text).not.toContain(GITHUB)
  })

  it('lists names and agent counts for everyone, and nothing else', async () => {
    const work = await data<CredentialProfile>('POST', '/credentials/profiles', { name: 'Work' })
    await newTask(work.id)
    const summaries = await data<ProfileSummary[]>('GET', '/credential-profiles')
    expect(summaries.find((profile) => profile.id === work.id)).toEqual({
      id: work.id,
      name: 'Work',
      builtin: false,
      agents: 1,
    })
  })
})
