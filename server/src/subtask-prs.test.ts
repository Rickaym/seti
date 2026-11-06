import {
  auditQuery,
  listedStatus,
  type MessagePage,
  type Subtask,
  type SubtaskBrief,
  type PrInput,
  type TaskListEntry,
} from '@seti/shared'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { messages, sql, tasks } from './db.js'
import type { WatchedPr } from './github.js'
import { deliverInputs, inputPreface } from './inputs.js'
import { migrate } from './pg.js'
import { createPrInputPoller } from './pr-inputs.js'
import { openQuerySince, runTurn, subscribe } from './runner.js'
import { auditEvents } from './store/audit.js'
import { prWatch } from './store/pr-watch.js'
import { agentCall, bash, launched, taskNotification, taskStarted, toolResult } from './subtask-fixtures.js'
import { inputSubtask } from './subtask-prs.js'
import { USER_AUTH } from './test-auth.js'

/** Each turn plays the script, then waits for finish() before its result. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  const state = { finish: (): void => undefined, script: (): unknown[] => [] }
  const fake = new FakeSdk(async function* ({ signal }) {
    yield* state.script() as { type: string }[]
    await new Promise<void>((resolve) => {
      state.finish = resolve
      signal.addEventListener('abort', () => {
        resolve()
      })
    })
    yield fakeResult()
  })
  return { state, fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const LIVE = 'subtask-pr-live'
const SEEDED = 'subtask-pr-seeded'
const SUB_PR = 'https://github.com/acme/app/pull/21'
const OWN_PR = 'https://github.com/acme/app/pull/22'
const MANUAL_PR = 'https://github.com/acme/web/pull/5'
const TASK_ONLY_PR = 'https://github.com/acme/web/pull/6'

const app = createApp()

const request = async (path: string, method = 'GET', body?: unknown) =>
  app.request(`/api/tasks${path}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const statusOf = async (path: string, method = 'GET', body?: unknown) => (await request(path, method, body)).status

async function data<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await request(path, method, body)
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const payload = (body: { payload: unknown }): unknown => body.payload

const linkPath = (toolUseId: string) => `/${SEEDED}/subtasks/${toolUseId}/prs`
const unlinkPath = (toolUseId: string, url: string) => `${linkPath(toolUseId)}?url=${encodeURIComponent(url)}`
const link = async (toolUseId: string, url: string) => data<Subtask>(linkPath(toolUseId), 'POST', { url })

function session() {
  const last = sdk.fake.last
  if (!last) {
    throw new Error('No session started')
  }
  return last
}

async function entryOf(taskId: string): Promise<TaskListEntry> {
  const entry = (await data<TaskListEntry[]>('')).find((task) => task.id === taskId)
  if (entry === undefined) {
    throw new Error(`Task ${taskId} is not listed`)
  }
  return entry
}

const inputRows = async (taskId: string): Promise<PrInput[]> =>
  (await messages.page(taskId, 200)).messages.flatMap((row) =>
    row.kind === 'input' && row.payload.source === 'pr' ? [row.payload] : [],
  )

const watched = (url: string, ci: WatchedPr['ci']): WatchedPr => ({
  url,
  subject: url.replace('https://github.com/', '').replace('/pull/', '#'),
  state: 'open',
  closed_at: null,
  conflicting: false,
  head_oid: `oid-${String(ci)}`,
  ci,
  checks: [],
  reviews: [],
  comments: [],
})

/** The poller as Seti runs it, with GitHub replaced by the states each test sets. */
function poller(states: Map<string, WatchedPr>) {
  const errors: unknown[] = []
  const poll = createPrInputPoller({
    watched: prWatch.watched,
    listeners: prWatch.listeners,
    subtask: async (taskId, toolUseId) => inputSubtask(taskId, toolUseId, openQuerySince(taskId)),
    snapshot: prWatch.snapshot,
    save: prWatch.save,
    fetch: async (urls) => Promise.resolve(new Map(urls.map((url) => [url, states.get(url) ?? null]))),
    viewer: async () => Promise.resolve('octocat'),
    deliver: deliverInputs,
    onError: (error) => errors.push(error),
  })
  return { poll: poll.poll, errors }
}

beforeAll(async () => {
  await tasks.insert({ id: LIVE, title: 'Live PRs', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  await tasks.insert({ id: SEEDED, title: 'Seeded PRs', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  for (const body of [
    { kind: 'prompt' as const, payload: { text: 'Fan out' } },
    agentCall('toolu_web', 'Fix web'),
    taskStarted({ taskId: 'w1', toolUseId: 'toolu_web', description: 'Fix web', background: true }),
    launched('toolu_web', 'w1'),
    agentCall('toolu_api', 'Fix api'),
    taskStarted({ taskId: 'p1', toolUseId: 'toolu_api', description: 'Fix api', background: true }),
    launched('toolu_api', 'p1'),
    taskNotification('w1', 'toolu_web', 'completed', 'Web fixed'),
    taskNotification('p1', 'toolu_api', 'completed', 'Api fixed'),
  ]) {
    await messages.insert(SEEDED, body, [])
  }
})

describe('PRs a subagent opens', () => {
  it('links them to the subagent as well as the task, and keeps the task running meanwhile', async () => {
    sdk.state.script = () => [
      payload(agentCall('toolu_pr', 'Open the fix PR')),
      payload(taskStarted({ taskId: 's1', toolUseId: 'toolu_pr', description: 'Open the fix PR', background: true })),
      payload(launched('toolu_pr', 's1')),
      payload(bash('toolu_own', 'gh pr create --fill')),
      payload(toolResult('toolu_own', `${OWN_PR}\n`)),
    ]
    const seen: SubtaskBrief[][] = []
    const unsubscribe = subscribe(LIVE, (event) => {
      if (event.type === 'subtasks') {
        seen.push(event.subtasks)
      }
    })
    await runTurn(LIVE, 'open a PR in the background')
    await vi.waitFor(async () => {
      expect((await tasks.get(LIVE))?.pr_urls).toEqual([OWN_PR])
    })
    sdk.state.finish()
    await vi.waitFor(async () => {
      expect((await tasks.get(LIVE))?.status).toBe('idle')
    })

    session().emit(payload(bash('toolu_gh', 'gh pr create --fill --base main', 'toolu_pr')) as { type: string })
    session().emit(payload(toolResult('toolu_gh', `${SUB_PR}\n`, { parent: 'toolu_pr' })) as { type: string })
    await vi.waitFor(() => {
      expect(seen.at(-1)?.[0]?.pr_urls).toEqual([SUB_PR])
    })
    expect((await tasks.get(LIVE))?.pr_urls).toEqual([OWN_PR, SUB_PR])
    const entry = await entryOf(LIVE)
    expect(entry.status).toBe('idle')
    expect(entry.running_subtasks.map((s) => [s.status, s.pr_urls])).toEqual([['running', [SUB_PR]]])
    expect(listedStatus(entry)).toBe('running')
    const audit = await auditEvents.page(auditQuery.parse({ kind: 'task', q: LIVE, limit: 10 }))
    expect(audit.events.map((e) => [e.kind, e.actor, e.summary]).slice(0, 2)).toEqual([
      ['task.subtask_pr_linked', 'agent', 'Linked PR acme/app#21 to subagent "Open the fix PR"'],
      ['task.pr_linked', 'agent', 'Linked PR acme/app#21'],
    ])
    unsubscribe()
  })

  it('routes updates on its PR to the parent, addressed to the subagent, while it runs and after', async () => {
    await tasks.setInputMode(LIVE, 'queue')
    const states = new Map([
      [SUB_PR, watched(SUB_PR, 'pending')],
      [OWN_PR, watched(OWN_PR, 'pending')],
    ])
    const { poll, errors } = poller(states)
    await poll()
    states.set(SUB_PR, watched(SUB_PR, 'failure'))
    states.set(OWN_PR, watched(OWN_PR, 'failure'))
    await poll()
    expect(errors).toEqual([])
    const running = { tool_use_id: 'toolu_pr', description: 'Open the fix PR', agent_id: 's1', running: true }
    expect((await inputRows(LIVE)).map((input) => [input.url, input.subtask ?? null])).toEqual([
      [SUB_PR, running],
      [OWN_PR, null],
    ])
    const preface = (await inputPreface(LIVE))?.text ?? ''
    expect(preface).toContain(
      'This update concerns the work of your subagent "Open the fix PR" (agent id s1), which was still running ' +
        'when it arrived. Continue that work with SendMessage to s1 if that agent is still available, or handle it yourself.',
    )
    expect(preface.match(/This update concerns/g)).toHaveLength(1)

    const seen: SubtaskBrief[][] = []
    const unsubscribe = subscribe(LIVE, (event) => {
      if (event.type === 'subtasks') {
        seen.push(event.subtasks)
      }
    })
    session().emit(payload(taskNotification('s1', 'toolu_pr', 'completed', 'PR opened')) as { type: string })
    await vi.waitFor(() => {
      expect(seen.at(-1)?.[0]?.status).toBe('completed')
    })
    unsubscribe()
    const entry = await entryOf(LIVE)
    expect(listedStatus(entry)).toBe('idle')

    states.set(SUB_PR, watched(SUB_PR, 'success'))
    await poll()
    expect((await inputRows(LIVE)).at(-1)?.subtask).toEqual({ ...running, running: false })
    expect((await inputPreface(LIVE))?.text).toContain(
      'This update concerns the work of your subagent "Open the fix PR" (agent id s1). Continue that work',
    )

    const page = await data<MessagePage>(`/${LIVE}/subtasks/toolu_pr/messages?limit=50`)
    const routed = page.messages.flatMap((row) => (row.kind === 'input' ? [row.payload.kind] : []))
    expect(routed).toEqual(['ci_failed', 'ci_passed'])
  })
})

describe('linking PRs to subagents by hand', () => {
  it('links a PR to one subagent, linking it to the task too, and moves it between subagents', async () => {
    expect((await link('toolu_web', MANUAL_PR)).pr_urls).toEqual([MANUAL_PR])
    expect((await tasks.get(SEEDED))?.pr_urls).toEqual([MANUAL_PR])

    expect((await link('toolu_api', MANUAL_PR)).pr_urls).toEqual([MANUAL_PR])
    const briefs = await data<SubtaskBrief[]>(`/${SEEDED}/subtasks`)
    expect(briefs.map((s) => [s.description, s.pr_urls])).toEqual([
      ['Fix web', []],
      ['Fix api', [MANUAL_PR]],
    ])
    expect(await statusOf(linkPath('toolu_missing'), 'POST', { url: MANUAL_PR })).toBe(404)
    expect(await statusOf(linkPath('toolu_api'), 'POST', { url: 'not a url' })).toBe(400)
  })

  it('unlinks a PR from the subagent only, and drops the subagent link with the task link', async () => {
    expect(await statusOf(unlinkPath('toolu_web', MANUAL_PR), 'DELETE')).toBe(404)
    expect((await data<Subtask>(unlinkPath('toolu_api', MANUAL_PR), 'DELETE')).pr_urls).toEqual([])
    expect((await tasks.get(SEEDED))?.pr_urls).toEqual([MANUAL_PR])

    await link('toolu_web', MANUAL_PR)
    expect(await statusOf(`/${SEEDED}/prs?url=${encodeURIComponent(MANUAL_PR)}`, 'DELETE')).toBe(200)
    expect(await sql`SELECT * FROM subtask_pr WHERE task_id = ${SEEDED}`).toEqual([])
    const audit = await auditEvents.page(auditQuery.parse({ kind: 'task', q: SEEDED, limit: 10 }))
    expect(audit.events.filter((e) => e.kind.startsWith('task.subtask_pr')).map((e) => e.summary)).toEqual([
      'Linked PR acme/web#5 to subagent "Fix web"',
      'Unlinked PR acme/web#5 from subagent "Fix api"',
      'Linked PR acme/web#5 to subagent "Fix api"',
      'Linked PR acme/web#5 to subagent "Fix web"',
    ])
  })

  it('leaves updates on a PR linked only to the task as they were', async () => {
    await tasks.setInputMode(SEEDED, 'queue')
    await tasks.linkPr(SEEDED, TASK_ONLY_PR, 'user')
    const states = new Map([[TASK_ONLY_PR, watched(TASK_ONLY_PR, 'pending')]])
    const { poll } = poller(states)
    await poll()
    states.set(TASK_ONLY_PR, watched(TASK_ONLY_PR, 'failure'))
    await poll()
    const [input] = await inputRows(SEEDED)
    expect(input).toMatchObject({ kind: 'ci_failed', url: TASK_ONLY_PR })
    expect(input).not.toHaveProperty('subtask')
    expect((await inputPreface(SEEDED))?.text).not.toContain('subagent')
  })
})

describe('the subtask_pr migration', () => {
  it('applies to a database that predates it and keeps existing task links', async () => {
    await sql`DROP TABLE subtask_pr`
    await sql`DELETE FROM schema_migration WHERE version = 5`
    expect(await migrate(sql)).toEqual([5])
    expect((await tasks.get(SEEDED))?.pr_urls).toEqual([TASK_ONLY_PR])
    await expect(
      sql`INSERT INTO subtask_pr (task_id, pr_url, tool_use_id, linked_at, source)
        VALUES (${SEEDED}, ${MANUAL_PR}, 'toolu_web', 'now', 'user')`,
    ).rejects.toThrow(/foreign key/)
    expect((await link('toolu_web', TASK_ONLY_PR)).pr_urls).toEqual([TASK_ONLY_PR])
  })
})
