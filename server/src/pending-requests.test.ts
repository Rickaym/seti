import { randomUUID } from 'node:crypto'
import { auditQuery, type PendingRequests, type SetiControlLevel, type Task } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { answerChangeRequest } from './change-requests.js'
import { tasks } from './db.js'
import { approveKnowledge } from './knowledge-review.js'
import { answerPermission } from './permission-rules.js'
import { auditEvents } from './store/audit.js'
import { changeRequests } from './store/change-requests.js'
import { knowledge } from './store/knowledge.js'
import { permissionRequests } from './store/permissions.js'
import { questions } from './store/questions.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const app = createApp()

async function newTask(level: SetiControlLevel = 'full'): Promise<Task> {
  const id = randomUUID()
  const fields = { title: `Requester ${id.slice(0, 8)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] }
  await tasks.insert({ id, ...fields, seti_control: level, sandbox: true })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('task was not stored')
  }
  return task
}

async function seed(task: Task) {
  const [question] = await questions.open([
    {
      id: randomUUID(),
      group_id: randomUUID(),
      task_id: task.id,
      subagent_id: null,
      tool_use_id: 'toolu_requests',
      position: 0,
      header: 'Checks',
      prompt: 'Which checks first?',
      kind: 'choice',
      multi: false,
      options: [
        { label: 'Lint', description: null },
        { label: 'Tests', description: null },
      ],
    },
  ])
  const access = await changeRequests.open({
    id: randomUUID(),
    task_id: task.id,
    change: { kind: 'allow_host', host: 'fixtures.example.com', port: 443 },
    reason: 'The tests download fixtures from there.',
    profile_id: 'default',
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  })
  const plan = await permissionRequests.open({
    id: randomUUID(),
    task_id: task.id,
    tool_name: 'ExitPlanMode',
    kind: 'tool',
    summary: 'Approve the plan and start on it',
    input: JSON.stringify({ plan: 'Fix the bug' }),
    reason: null,
    suggestions: [],
    editable: false,
  })
  const note = await knowledge.insert({
    id: randomUUID(),
    kind: 'gotcha',
    title: `Build first ${task.id.slice(0, 8)}`,
    body: 'Run pnpm build before pnpm e2e.',
    verify: 'pnpm build',
    sources: [],
    repo_id: null,
    proposer: 'agent',
    proposer_task_id: task.id,
    proposer_title: task.title,
    corrects_id: null,
  })
  if (question === undefined || access === undefined) {
    throw new Error('the requests were not stored')
  }
  return { question, access, plan, note }
}

const get = async (url: string, auth: Record<string, string>) =>
  app.request(`/api${url}`, { headers: { host: 'localhost', ...auth } })

const post = async (url: string, body: object, auth: Record<string, string>) =>
  app.request(`/api${url}`, {
    method: 'POST',
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const listed = async (res: Response) => {
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: PendingRequests }).data
}

describe('GET /api/requests', () => {
  it('lists every kind of pending request for the user and the EA, of all agents or of one', async () => {
    const task = await newTask()
    const other = await newTask()
    const seeded = await seed(task)
    await seed(other)
    for (const auth of [USER_AUTH, EA_AUTH]) {
      const all = await listed(await get('/requests', auth))
      expect(all.questions.map((q) => q.id)).toContain(seeded.question.id)
      expect(all.access.find((r) => r.id === seeded.access.id)).toMatchObject({ task_title: task.title })
      expect(all.permissions.find((r) => r.id === seeded.plan.id)).toMatchObject({ task_title: task.title })
      expect(all.notes.map((n) => n.id)).toContain(seeded.note.id)
    }
    const mine = await listed(await get(`/requests?task_id=${task.id}`, USER_AUTH))
    expect(mine.questions.map((q) => q.id)).toEqual([seeded.question.id])
    expect(mine.access.map((r) => r.id)).toEqual([seeded.access.id])
    expect(mine.permissions.map((r) => r.id)).toEqual([seeded.plan.id])
    expect(mine.notes.map((n) => n.id)).toEqual([seeded.note.id])
  })

  it('refuses a malformed agent id', async () => {
    expect((await get('/requests?task_id=../x', USER_AUTH)).status).toBe(400)
  })
})

describe('answering what the Requests panel lists stays the user', () => {
  it('gives the EA 403 on access, plans and notes, and leaves them pending', async () => {
    const task = await newTask()
    const { access, plan, note } = await seed(task)
    const tries = [
      post(`/tasks/${task.id}/change-requests/${access.id}`, { decision: 'allow' }, EA_AUTH),
      post(`/tasks/${task.id}/permission-requests/${plan.id}`, { decision: 'allow' }, EA_AUTH),
      post(`/knowledge/${note.id}/approve`, {}, EA_AUTH),
    ]
    for (const res of await Promise.all(tries)) {
      expect(res.status).toBe(403)
    }
    const after = await listed(await get(`/requests?task_id=${task.id}`, USER_AUTH))
    expect(after.access.map((r) => r.state)).toEqual(['pending'])
    expect(after.permissions.map((r) => r.state)).toEqual(['pending'])
    expect(after.notes.map((n) => n.status)).toEqual(['proposed'])
  })

  it('gives agents 403 on access, plans and notes, at Full Seti control too', async () => {
    const task = await newTask()
    const agent = await newTask('full')
    const { access, plan, note } = await seed(task)
    await expect(
      asAgent(agent, async () => answerChangeRequest(task, access.id, { decision: 'allow' })),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      asAgent(agent, async () => answerPermission(task, plan.id, { decision: 'allow' })),
    ).rejects.toMatchObject({ status: 403 })
    await expect(asAgent(agent, async () => approveKnowledge(note.id, {}))).rejects.toMatchObject({ status: 403 })
    expect((await changeRequests.get(access.id))?.state).toBe('pending')
  })

  it('audits an access Allow from the user as the user', async () => {
    const task = await newTask()
    const { access } = await seed(task)
    expect(
      (await post(`/tasks/${task.id}/change-requests/${access.id}`, { decision: 'allow' }, USER_AUTH)).status,
    ).toBe(200)
    const [event] = (await auditEvents.page(auditQuery.parse({ kind: 'task.change_allowed', limit: 1 }))).events
    expect(event).toMatchObject({ actor: 'user', subject_id: task.id, detail: { request_id: access.id } })
  })
})
