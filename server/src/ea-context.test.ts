import type {
  AgentTodo,
  EaContext,
  MessageRow,
  PullRequest,
  SubtaskBrief,
  Task,
  TaskStatus,
  TeamMessage,
} from '@seti/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { messages, sql, tasks } from './db.js'
import { CONTEXT_BUDGET_CHARS, renderContext } from './ea-context-render.js'
import { span, type ContextInput } from './ea-context-tasks.js'
import { followLiveContext, invalidateContext, isHardChange, liveContext } from './ea-context.js'
import { assistant, toolResult, toolUse } from './subtask-fixtures.js'
import { postTeamMessage } from './team.js'
import { USER_AUTH } from './test-auth.js'

const NOW = Date.parse('2026-09-28T12:00:00Z')
const MIN = 60_000
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const PR = 'https://github.com/acme/web/pull/7'
const OTHER_PR = 'https://github.com/acme/web/pull/9'

function task(id: string, title: string, status: TaskStatus, extra: Partial<Task> & { age?: number } = {}): Task {
  const { age: updatedAgo = MIN, ...rest } = extra
  return {
    id,
    title,
    repo_id: 'r1',
    repo_slug: 'acme/web',
    repos: [],
    dirs: [],
    cwd: '/tmp',
    worktree: false,
    sandbox: true,
    profile_id: 'default',
    seti_control: 'self',
    bypass_until: null,
    pr_urls: [],
    input_mode: 'wake',
    session_id: null,
    source_session_id: null,
    status,
    permission_mode: null,
    model: null,
    cost_usd: 0,
    outward_count: 0,
    last_error: null,
    created_at: ago(updatedAgo + MIN),
    updated_at: ago(updatedAgo),
    archived_at: null,
    pinned: false,
    color: null,
    setup: null,
    warm_caches: [],
    workspace_id: 'w1',
    notifications_muted: false,
    status_line: null,
    status_line_at: null,
    unseen: false,
    asking: false,
    closing_line: null,
    blocked: null,
    ...rest,
  }
}

let rowId = 0

function row(taskId: string, body: Pick<MessageRow, 'kind' | 'payload'>, at = NOW): MessageRow {
  rowId += 1
  return { ...body, id: rowId, task_id: taskId, outward: [], created_at: new Date(at).toISOString() } as MessageRow
}

function openPr(url: string, extra: Partial<PullRequest> = {}): NonNullable<ContextInput['prs']>[number] {
  const number = Number(url.split('/').at(-1))
  return {
    url,
    repo_slug: 'acme/web',
    number,
    title: `Change ${String(number)}`,
    author: 'octo',
    draft: false,
    ci: 'success',
    checks: [],
    unresolved_threads: 0,
    review_decision: null,
    mergeable: 'mergeable',
    preview: { state: 'none', url: null, commit: null, stale: false },
    ...extra,
  }
}

function input(extra: Partial<ContextInput> = {}): ContextInput {
  return {
    now: NOW,
    tasks: [],
    prStates: new Map(),
    sessions: new Map(),
    waiting: new Map(),
    activity: new Map(),
    todos: new Map(),
    prs: [],
    viewer: 'octo',
    notable: [],
    eaChannels: new Set(),
    team: [],
    roles: new Map(),
    ...extra,
  }
}

const lineOf = (text: string, needle: string) => text.split('\n').findIndex((line) => line.includes(needle))

function subagent(description: string, background: boolean): SubtaskBrief {
  return {
    tool_use_id: `tu-${description}`,
    tool_use_ids: [`tu-${description}`],
    parent_tool_use_id: null,
    message_id: 1,
    sdk_task_id: null,
    description,
    subagent_type: 'Explore',
    background,
    status: 'running',
    progress: null,
    usage: null,
    started_at: ago(3 * MIN),
    ended_at: null,
    summary: null,
    pr_urls: [],
  }
}

describe('renderContext', () => {
  it('lists running tasks first, then errors and waiting updates, and shows complete tasks', () => {
    const { text } = renderContext(
      input({
        tasks: [
          task('old', 'Old cleanup', 'idle', { age: 2 * 24 * 60 * MIN }),
          task('done', 'Speech engine', 'idle', { age: 30 * MIN, pr_urls: [PR] }),
          task('wait', 'Dashboard export', 'idle', { age: 90 * MIN, input_mode: 'queue' }),
          task('err', 'PII redaction', 'error', { age: 5 * MIN, last_error: 'Claude API overloaded' }),
          task('run', 'Voicemail detection', 'running', { age: 12 * MIN }),
        ],
        prStates: new Map([['done', { [PR]: 'merged' }]]),
        waiting: new Map([['wait', 3]]),
      }),
    )
    const order = ['Voicemail detection', 'PII redaction', 'Dashboard export', 'Speech engine'].map((title) =>
      lineOf(text, title),
    )
    expect(order.every((index) => index > 0)).toBe(true)
    expect(order).toEqual(order.toSorted((a, b) => a - b))
    expect(text).toContain('"Voicemail detection" (web) RUNNING for 12m')
    expect(text).toContain('ERROR 5m ago; error: Claude API overloaded')
    expect(text).toContain('3 updates waiting, held for the user')
    expect(text).toContain('"Speech engine" (web) COMPLETE')
    expect(text).toContain('web#7 merged')
    expect(text).toContain('Tasks: 5 in all; 1 running, 1 error, 2 idle, 1 complete. Most urgent first:')
  })

  it('shows subagents of a running task and an idle task whose background subagents still run', () => {
    const { text, tasks: covered } = renderContext(
      input({
        tasks: [task('run', 'Voicemail', 'running', { age: 2 * MIN }), task('bg', 'Indexer', 'idle', { age: 4 * MIN })],
        sessions: new Map([
          ['run', { background: 0, subagents: [subagent('find VAD config', false), subagent('read logs', false)] }],
          ['bg', { background: 1, subagents: [subagent('reindex docs', true)] }],
        ]),
      }),
    )
    expect(text).toContain('RUNNING for 2m, 2 subagents running')
    expect(text).toContain('subagents "find VAD config" (Explore, 3m), "read logs" (Explore, 3m)')
    expect(text).toContain('"Indexer" (web) RUNNING SUBAGENTS: main agent idle 4m, 1 background subagents running')
    expect(covered.map((t) => t.id)).toEqual(['run', 'bg'])
  })

  it('says what a running agent is doing and how an idle one ended its turn', () => {
    const tool = assistant([
      { type: 'text', text: 'Running the suite.' },
      toolUse('b1', 'Bash', { command: 'pnpm test' }),
    ])
    const result = {
      kind: 'sdk',
      payload: { type: 'result', subtype: 'success', is_error: false, result: 'Opened PR 7.' },
    }
    const { text } = renderContext(
      input({
        tasks: [
          task('run', 'Voicemail', 'running', { age: MIN }),
          task('ran', 'Tests', 'running', { age: MIN }),
          task('idle', 'Docs', 'idle', { age: MIN }),
        ],
        activity: new Map([
          ['run', [row('run', tool)]],
          ['ran', [row('ran', toolResult('b1', 'ok')), row('ran', tool)]],
          ['idle', [row('idle', result as Pick<MessageRow, 'kind' | 'payload'>)]],
        ]),
      }),
    )
    expect(text).toContain('"Voicemail" (web) RUNNING for 1m; now running pnpm test')
    expect(text).toContain('"Tests" (web) RUNNING for 1m; now just ran pnpm test')
    expect(text).toContain('"Docs" (web) IDLE 1m; last reply "Opened PR 7."')
  })

  it("names an agent's role pack", () => {
    const { text } = renderContext(
      input({
        tasks: [task('lead', 'Release', 'idle', { pinned: true }), task('dev', 'Docs', 'idle')],
        roles: new Map([['lead', 'Lead']]),
      }),
    )
    expect(text).toContain('"Release" (web) IDLE 1m; role "Lead"')
    expect(text.split('\n').find((line) => line.includes('"Docs"'))).not.toContain('role')
  })

  it("sums up an agent's todo list with the item in progress", () => {
    const item = (id: string, status: AgentTodo['status']): AgentTodo => ({
      id,
      content: `Step ${id}`,
      active_form: `Doing step ${id}`,
      status,
    })
    const { text } = renderContext(
      input({
        tasks: [task('run', 'Voicemail', 'running', { age: MIN }), task('idle', 'Docs', 'idle')],
        todos: new Map([['run', [item('1', 'completed'), item('2', 'in_progress'), item('3', 'pending')]]]),
      }),
    )
    expect(text).toContain('todos 1/3 done, now "Doing step 2"')
    expect(text.split('\n').find((line) => line.includes('"Docs"'))).not.toContain('todos')
  })

  it("puts failing PRs first and keeps only the user's PRs and those linked to tasks", () => {
    const { text } = renderContext(
      input({
        tasks: [task('run', 'Voicemail', 'running', { age: MIN, pr_urls: [OTHER_PR] })],
        prs: [
          openPr(PR, {
            ci: 'success',
            unresolved_threads: 2,
            review_decision: 'approved',
            preview: { state: 'ready', url: 'https://p', commit: 'a', stale: false },
          }),
          openPr(OTHER_PR, {
            author: 'someone',
            ci: 'failure',
            checks: [{ name: 'e2e', state: 'failure', detail: 'failure', url: null }],
            mergeable: 'conflicting',
          }),
          openPr('https://github.com/acme/web/pull/11', { author: 'someone' }),
        ],
      }),
    )
    expect(text).toContain('Open PRs: 2 (1 yours, 1 others linked to tasks)')
    expect(lineOf(text, 'web#9 "Change 9"')).toBeLessThan(lineOf(text, 'web#7 "Change 7"'))
    expect(text).toContain('web#9 "Change 9" (task "Voicemail"): CI failing: e2e; merge conflicts')
    expect(text).toContain('web#7 "Change 7" (yours): CI green; 2 unresolved review threads; approved; preview ready')
    expect(text).not.toContain('web#11')
    expect(text).toContain('PRs web#9 CI failing')
  })

  it('says when GitHub has not answered yet', () => {
    expect(renderContext(input({ prs: null })).text).toContain('Open PRs: GitHub has not answered yet')
  })

  it('reports events of the last hour only', () => {
    const t = task('run', 'Voicemail', 'idle', { age: MIN })
    const ended = { kind: 'sdk', payload: { type: 'result', subtype: 'success', is_error: false, result: 'x' } }
    const ci = {
      kind: 'input',
      payload: {
        source: 'pr',
        kind: 'ci_failed',
        subject: 'acme/web#7',
        title: 'CI failed on acme/web#7',
        body: '',
        url: PR,
      },
    }
    const { text } = renderContext(
      input({
        tasks: [t],
        notable: [
          row('run', ended as Pick<MessageRow, 'kind' | 'payload'>, NOW - 5 * MIN),
          row('run', ci as Pick<MessageRow, 'kind' | 'payload'>, NOW - 20 * MIN),
          row('run', ended as Pick<MessageRow, 'kind' | 'payload'>, NOW - 90 * MIN),
        ],
      }),
    )
    expect(text).toContain('- 5m ago: task "Voicemail" finished its turn')
    expect(text).toContain('- 20m ago: CI failed on acme/web#7 (task "Voicemail")')
    expect(text.match(/finished its turn/g)).toHaveLength(1)
  })

  it('reports task updates from channels only when the EA subscribes to the channel', () => {
    const t = task('feed', 'Security', 'idle', { age: MIN })
    const update = (channelId: string, title: string) =>
      ({
        kind: 'input',
        payload: {
          source: 'channel',
          kind: 'alert',
          channel: channelId,
          channel_id: channelId,
          event_id: 1,
          severity: 'warning',
          subject: 'Feed',
          title,
          body: '',
          url: null,
          received_at: new Date(NOW).toISOString(),
        },
      }) as Pick<MessageRow, 'kind' | 'payload'>
    const { text } = renderContext(
      input({
        tasks: [t],
        eaChannels: new Set(['followed']),
        notable: [
          row('feed', update('followed', 'Followed alert'), NOW - 2 * MIN),
          row('feed', update('ignored', 'Ignored alert'), NOW - 3 * MIN),
        ],
      }),
    )
    expect(text).toContain('Followed alert (task "Security")')
    expect(text).not.toContain('Ignored alert')
  })

  it('summarises the last six hours of group chat, newest first', () => {
    const chat = (author: string | null, text: string, minutesAgo: number, handles: string[] = []) =>
      ({
        id: minutesAgo,
        author_kind: author === null ? 'user' : 'task',
        author_task_id: author === null ? null : `task-${author}`,
        author_handle: author,
        text,
        mentions: handles.map((handle) => ({ handle, task_id: null })),
        to_kind: null,
        to_task_id: null,
        to_handle: null,
        created_at: new Date(NOW - minutesAgo * MIN).toISOString(),
      }) satisfies TeamMessage
    const { text } = renderContext(
      input({
        team: [
          chat('sip', 'Old news from the morning', 7 * 60),
          chat('sip', 'Changing the SIP trunk config', 30),
          chat('llm', '@user the box model needs a restart', 12, ['user']),
          chat(null, 'Thanks, go ahead', 3),
        ],
      }),
    )
    expect(text).toContain('Group chat in the last 6 hours, newest first (3 messages, 2 agents):')
    const lines = ['- 3m ago user: Thanks', '- 12m ago @llm: @user the box', '- 30m ago @sip: Changing']
    expect(lines.map((line) => lineOf(text, line))).toEqual(lines.map((_, i) => lineOf(text, lines[0] ?? '') + i))
    expect(text).not.toContain('Old news')
  })

  it('keeps the newest events and chat messages when tasks and failing PRs fill the budget', () => {
    const busy = Array.from({ length: 30 }, (_, i) =>
      task(`b${String(i)}`, `Idle task ${String(i)} ${'with a long descriptive title '.repeat(9)}`, 'idle', {
        age: (i + 1) * MIN,
      }),
    )
    const prs = Array.from({ length: 30 }, (_, i) =>
      openPr(`https://github.com/acme/web/pull/${String(300 + i)}`, {
        ci: 'failure',
        title: `Fix ${'the flaky pipeline stage again '.repeat(4)}`,
      }),
    )
    const ended = { kind: 'sdk', payload: { type: 'result', subtype: 'success', is_error: false, result: 'x' } }
    const team = [5, 4, 3, 2, 1].map(
      (minutesAgo) =>
        ({
          id: minutesAgo,
          author_kind: 'task',
          author_task_id: `b${String(minutesAgo)}`,
          author_handle: `agent${String(minutesAgo)}`,
          text: `Status line number ${String(minutesAgo)}`,
          mentions: [],
          to_kind: null,
          to_task_id: null,
          to_handle: null,
          created_at: new Date(NOW - minutesAgo * MIN).toISOString(),
        }) satisfies TeamMessage,
    )
    const { text } = renderContext(
      input({
        tasks: busy,
        prs,
        team,
        notable: [row('b0', ended as Pick<MessageRow, 'kind' | 'payload'>, NOW - 2 * MIN)],
      }),
    )
    expect(text.length).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARS)
    expect(text).toContain('task "Idle task 0')
    expect(text).toContain('@agent1: Status line number 1')
    expect(text).toContain('@agent3: Status line number 3')
    expect(text).toContain('- 2m ago: task "Idle task 0')
    expect(text).toMatch(/Not listed: \d+ more \(\d+ idle\)/)
  })

  it('stays within its budget, keeping what matters and counting the rest', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      task(`t${String(i)}`, `Idle task number ${String(i)} with a long descriptive title`, 'idle', {
        age: (i + 1) * MIN,
      }),
    )
    const prs = Array.from({ length: 40 }, (_, i) => openPr(`https://github.com/acme/web/pull/${String(100 + i)}`))
    const {
      text,
      tokens,
      tasks: covered,
    } = renderContext(input({ tasks: [...many, task('run', 'Voicemail detection', 'running', { age: MIN })], prs }))
    expect(text.length).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARS)
    expect(tokens).toBeLessThanOrEqual(1500)
    expect(text).toContain('"Voicemail detection" (web) RUNNING')
    expect(text).toMatch(/Not listed: \d+ more \(\d+ idle\)/)
    expect(text).toMatch(/Not listed: \d+ more open PRs, \d+ of them with CI green/)
    expect(covered).toHaveLength(201)
  })

  it('redacts credentials', () => {
    const { text } = renderContext(
      input({
        tasks: [task('err', 'Deploy', 'error', { age: MIN, last_error: 'token ghp_abcdefghijklmnopqrstu rejected' })],
      }),
    )
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstu')
  })
})

describe('span', () => {
  it('reads as seconds, minutes, hours and days', () => {
    expect([span(4000), span(12 * MIN), span(125 * MIN), span(7 * 60 * MIN), span(3 * 24 * 60 * MIN)]).toEqual([
      '4s',
      '12m',
      '2h 5m',
      '7h',
      '3d',
    ])
  })
})

describe('isHardChange', () => {
  const sdkRow = (type: string) =>
    ({
      type: 'message',
      row: row('x', { kind: 'sdk', payload: { type } } as Pick<MessageRow, 'kind' | 'payload'>),
    }) as const

  it('treats status, PR and subagent changes and turn ends as hard, streamed text as soft', () => {
    expect(isHardChange({ type: 'status', status: 'idle' })).toBe(true)
    expect(isHardChange({ type: 'prs' })).toBe(true)
    expect(isHardChange({ type: 'subtasks', subtasks: [] })).toBe(true)
    expect(isHardChange(sdkRow('result'))).toBe(true)
    expect(isHardChange(sdkRow('assistant'))).toBe(false)
    expect(isHardChange({ type: 'shell', progress: { stream: 'stdout', text: '' } } as never)).toBe(false)
  })
})

describe('GET /api/ea/context', () => {
  const app = createApp()
  const LOCAL = { host: '127.0.0.1:3006', ...USER_AUTH }
  let count = 0

  async function newTask(title: string): Promise<string> {
    count += 1
    const id = `ctx-${String(count)}`
    await tasks.insert({ id, title, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    return id
  }

  const fetchContext = async () => {
    const res = await app.request('/api/ea/context', { headers: LOCAL })
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: EaContext }).data
  }

  beforeEach(async () => {
    await sql`DELETE FROM task`
    invalidateContext(true)
  })

  it('describes the tasks, rebuilding after hard changes and not after streamed text', async () => {
    const id = await newTask('Voicemail detection')
    await messages.insert(id, assistant([{ type: 'text', text: 'Looking at the VAD settings now.' }]), [])
    const first = await fetchContext()
    expect(first.text).toContain('"Voicemail detection" IDLE')
    expect(first.tasks).toEqual([{ id, title: 'Voicemail detection', status: 'idle' }])
    expect(first.tokens).toBe(Math.ceil(first.text.length / 4))

    await tasks.setStatus(id, 'running', null)
    invalidateContext(false)
    expect((await fetchContext()).as_of).toBe(first.as_of)

    invalidateContext(true)
    const rebuilt = await fetchContext()
    expect(rebuilt.text).toContain('"Voicemail detection" RUNNING for')
    expect(rebuilt.text).toContain('now said "Looking at the VAD settings now."')
  })

  it('picks up a new group chat message at once', async () => {
    followLiveContext()
    expect((await fetchContext()).text).not.toContain('Deploy window opens at four')
    await postTeamMessage({ kind: 'user' }, 'Deploy window opens at four')
    expect((await fetchContext()).text).toContain('user: Deploy window opens at four')
  })

  it('serves concurrent callers from one build', async () => {
    await newTask('Speech engine')
    const [a, b] = await Promise.all([liveContext(), liveContext()])
    expect(a).toBe(b)
  })
})
