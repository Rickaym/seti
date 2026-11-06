import fs from 'node:fs'
import { handleCandidates, parseMentions, type AuditEvent, type TeamPosted } from '@seti/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { messages, sql, tasks } from './db.js'
import { inputPreface } from './inputs.js'
import { endSession, isRunning, runTurn } from './runner.js'
import { auditEvents } from './store/audit.js'
import { eaInbox } from './store/inbox.js'
import { teamMessages } from './store/team.js'
import { ensureMember, postTeamMessage, TEAM_BURST, TEAM_LOOP } from './team.js'
import { USER_AUTH, EA_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-team-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

/** Turns of tasks in `hang` wait for release(); every turn records which task ran what. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  const state = {
    hang: new Set<string>(),
    release: new Map<string, () => void>(),
    turns: [] as { task: string; text: string }[],
  }
  const fake = new FakeSdk(async function* ({ text, signal, session }) {
    const task = session.options.env?.SETI_TASK_ID ?? ''
    state.turns.push({ task, text })
    if (state.hang.has(task)) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve()
        })
        state.release.set(task, resolve)
      })
    }
    yield fakeResult()
  })
  return { state, fake }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.fake.query,
}))

const app = createApp()
const LOCAL = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }
let taskNumber = 0
const created: string[] = []

async function newTask(title: string): Promise<string> {
  taskNumber += 1
  const id = `team-task-${String(taskNumber)}`
  created.push(id)
  await tasks.insert({ id, title, repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
  await ensureMember({ id, title })
  return id
}

const handleOf = async (id: string) => (await ensureMember({ id, title: '' })).handle

/** Starts a turn that keeps running until release(). */
async function busy(id: string): Promise<void> {
  sdk.state.hang.add(id)
  await runTurn(id, 'Work on it')
  await vi.waitFor(() => {
    expect(sdk.state.release.has(id)).toBe(true)
  })
}

async function release(id: string): Promise<void> {
  sdk.state.hang.delete(id)
  sdk.state.release.get(id)?.()
  sdk.state.release.delete(id)
  await waitIdle(id)
}

const turnsOf = (id: string) => sdk.state.turns.filter((turn) => turn.task === id)
const priorities = (id: string) =>
  sdk.fake.sessions.filter((session) => session.options.env?.SETI_TASK_ID === id).flatMap((s) => s.priorities)
const sentTo = (id: string) =>
  sdk.fake.sessions.filter((session) => session.options.env?.SETI_TASK_ID === id).flatMap((s) => s.inputs)
const inputRows = async (id: string) => (await messages.page(id, 100)).messages.filter((row) => row.kind === 'input')
const modes = (posted: TeamPosted) => Object.fromEntries(posted.deliveries.map((d) => [d.task_id, d.mode]))

async function deliveryAudits(): Promise<AuditEvent[]> {
  await auditEvents.settled()
  return (await auditEvents.page({ kind: 'team.message_delivered', limit: 200 })).events
}

beforeEach(async () => {
  sdk.state.turns.length = 0
  await sql`UPDATE task SET updated_at = '2000-01-01T00:00:00.000Z'`
})

afterEach(async () => {
  for (const id of created) {
    await endSession(id)
  }
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('handles', () => {
  it('derives a short handle from the title and keeps it unique', async () => {
    expect(handleCandidates('Fix voicemail detection')).toEqual(['voicemail', 'voicemail-detection'])
    expect(handleCandidates('Add the ALL button')).toEqual(['all-task', 'all-task-button'])
    expect(handleCandidates('!!!')).toEqual(['task'])
    const first = await newTask('Fix voicemail detection')
    const second = await newTask('Voicemail detection tests')
    const third = await newTask('Fix voicemail detection again')
    expect(await handleOf(first)).toBe('voicemail')
    expect(await handleOf(second)).toBe('voicemail-detection')
    expect(await handleOf(third)).toBe('voicemail-2')
  })

  it('keeps a handle when the title changes and lets the user rename it', async () => {
    const id = await newTask('Billing export')
    await tasks.setTitle(id, 'Something else entirely')
    expect(await handleOf(id)).toBe('billing')
    const renamed = await app.request(`/api/team/members/${id}`, {
      method: 'PATCH',
      headers: LOCAL,
      body: JSON.stringify({ handle: '@Invoices' }),
    })
    expect(renamed.status).toBe(200)
    expect(await handleOf(id)).toBe('invoices')
    const other = await newTask('Payments')
    const taken = await app.request(`/api/team/members/${other}`, {
      method: 'PATCH',
      headers: LOCAL,
      body: JSON.stringify({ handle: 'invoices' }),
    })
    expect(taken.status).toBe(409)
    const reserved = await app.request(`/api/team/members/${other}`, {
      method: 'PATCH',
      headers: LOCAL,
      body: JSON.stringify({ handle: 'all' }),
    })
    expect(reserved.status).toBe(400)
    await auditEvents.settled()
    expect(await auditEvents.latest('team.member_changed')).toMatchObject({
      actor: 'user',
      subject_id: id,
      summary: 'For task "Something else entirely": renamed @billing to @invoices',
    })
  })

  it('gives a renamed agent the handle its new title suggests', async () => {
    const id = await newTask('Billing export')
    expect(await handleOf(id)).toBe('billing')
    const rename = async (title: string) =>
      app.request(`/api/tasks/${id}`, { method: 'PATCH', headers: LOCAL, body: JSON.stringify({ title }) })
    expect((await rename('Ledger sync')).status).toBe(200)
    expect(await handleOf(id)).toBe(handleCandidates('Ledger sync')[0])
    await auditEvents.settled()
    expect(await auditEvents.latest('team.member_changed')).toMatchObject({ actor: 'system', subject_id: id })
    const before = await handleOf(id)
    expect((await rename('Ledger sync nightly')).status).toBe(200)
    expect(await handleOf(id)).toBe(before)
  })
})

describe('mentions', () => {
  it('finds handles after spaces and punctuation, never inside emails or paths', () => {
    expect(parseMentions('@Voicemail, can you ask @all? cc (@ea) and @user.')).toEqual([
      'voicemail',
      'all',
      'ea',
      'user',
    ])
    expect(parseMentions('mail me@example.com or see ./@scope/pkg and a/@b')).toEqual([])
    expect(parseMentions('@api- then @api again, @a-b-c-')).toEqual(['api', 'a-b-c'])
  })

  it('stores mentions with the tasks they name and reports unknown handles', async () => {
    const id = await newTask('Search indexer')
    const posted = await postTeamMessage({ kind: 'user' }, 'Hey @search and @nobody, see @user')
    expect(posted.message.mentions).toEqual([
      { handle: 'search', task_id: id },
      { handle: 'user', task_id: null },
    ])
    expect(posted.unknown).toEqual(['nobody'])
    await waitIdle(id)
  })

  it('drops the heading an agent wrote atop its own post', async () => {
    const author = await newTask('Heading writer')
    const { handle } = await ensureMember({ id: author, title: 'Heading writer' })
    const posted = await postTeamMessage(
      { kind: 'task', taskId: author },
      `### @${handle}, 2026-10-14 05:24Z\nall green`,
    )
    expect(posted.message.text).toBe('all green')
  })
})

describe('delivery', () => {
  it('starts a turn for a mentioned idle task and records the message in its transcript', async () => {
    const id = await newTask('Idle mention target')
    const posted = await postTeamMessage({ kind: 'user' }, '@idle please look at the flaky test')
    expect(modes(posted)).toEqual({ [id]: 'start' })
    await waitIdle(id)
    const [turn] = turnsOf(id)
    expect(turn?.text).toContain('Seti group chat')
    expect(turn?.text).toContain('<team-chat from="user" kind="mention"')
    expect(turn?.text).toContain('@idle please look at the flaky test')
    expect((await inputRows(id)).map((row) => row.payload)).toMatchObject([
      { source: 'team', kind: 'mention', subject: 'user', message_id: posted.message.id },
    ])
  })

  it("joins the user's mention to the running turn at once, as a person's message", async () => {
    const target = await newTask('Running target')
    await busy(target)
    const posted = await postTeamMessage({ kind: 'user' }, '@running which branch are you on?')
    expect(modes(posted)).toEqual({ [target]: 'now' })
    expect(sentTo(target).at(-1)).toMatchObject({ priority: 'now', origin: { kind: 'human' } })
    await release(target)
    expect(turnsOf(target).at(-1)?.text).toContain('they arrived while you were working')
  })

  it('reaches a running task an agent mentions at its next step, never cutting the turn', async () => {
    const author = await newTask('Mention author')
    const target = await newTask('Busy target')
    await busy(target)
    const posted = await postTeamMessage({ kind: 'task', taskId: author }, '@busy which branch are you on?')
    expect(modes(posted)).toEqual({ [target]: 'next' })
    expect(sentTo(target).at(-1)?.priority).toBe('next')
    expect(sentTo(target).at(-1)?.origin).toBeUndefined()
    await release(target)
  })

  it('reaches running tasks at their next step for @all, and starts idle ones only for the user', async () => {
    const running = await newTask('Broadcast running')
    const idle = await newTask('Broadcast idle')
    const author = await newTask('Broadcast author')
    await sql`UPDATE task SET updated_at = ${new Date().toISOString()} WHERE id IN (${idle}, ${author})`
    await busy(running)
    const fromAgent = await postTeamMessage({ kind: 'task', taskId: author }, '@all main is green again')
    expect(modes(fromAgent)).toEqual({ [running]: 'next', [idle]: 'held' })
    expect(priorities(running)).toContain('next')
    expect(fromAgent.deliveries.find((d) => d.task_id === idle)?.reason).toBe('idle')
    const fromUser = await postTeamMessage({ kind: 'user' }, '@all please rebase on main')
    expect(modes(fromUser)).toMatchObject({ [running]: 'next', [idle]: 'start', [author]: 'start' })
    await release(running)
    await waitIdle(idle)
    await waitIdle(author)
    const idleTurn = turnsOf(idle).at(-1)?.text ?? ''
    expect(idleTurn).toContain('main is green again')
    expect(idleTurn).toContain('please rebase on main')
  })

  it('sends every EA post to active tasks, starting idle ones only with @all', async () => {
    const running = await newTask('Ea running')
    const idle = await newTask('Ea idle')
    const stale = await newTask('Ea stale')
    await sql`UPDATE task SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ${stale}`
    await busy(running)
    const response = await app.request('/api/team/messages', {
      method: 'POST',
      headers: { ...LOCAL, ...EA_AUTH },
      body: JSON.stringify({ text: 'The user asks everyone to pause deploys.' }),
    })
    const posted = ((await response.json()) as { data: TeamPosted }).data
    expect(posted.message.author_kind).toBe('ea')
    expect(modes(posted)).toEqual({ [running]: 'next', [idle]: 'held' })
    expect(Object.keys(modes(posted))).not.toContain(stale)
    await release(running)
  })

  it('never hands a task its own message and skips muted tasks', async () => {
    const author = await newTask('Self author')
    const muted = await newTask('Muted listener')
    await sql`UPDATE task SET updated_at = ${new Date().toISOString()} WHERE id IN (${author}, ${muted})`
    await app.request(`/api/team/members/${muted}`, {
      method: 'PATCH',
      headers: LOCAL,
      body: JSON.stringify({ muted: true }),
    })
    const posted = await postTeamMessage({ kind: 'task', taskId: author }, '@self @muted @all ping')
    expect(posted.deliveries.find((d) => d.task_id === author)).toBeUndefined()
    expect(posted.deliveries.find((d) => d.task_id === muted)).toMatchObject({ mode: 'skipped', reason: 'muted' })
    expect(await inputRows(muted)).toEqual([])
    expect(await inputRows(author)).toEqual([])
    for (const delivery of posted.deliveries) {
      await waitIdle(delivery.task_id)
    }
  })

  it('hands a quick reply to the task that asked, waking it when idle', async () => {
    const a = await newTask('Pingpong alpha')
    const b = await newTask('Pingpong beta')
    const first = await postTeamMessage({ kind: 'task', taskId: a }, '@pingpong-beta are you done?')
    expect(modes(first)).toEqual({ [b]: 'start' })
    await waitIdle(b)
    const back = await postTeamMessage({ kind: 'task', taskId: b }, '@pingpong yes, and you?')
    expect(back.deliveries).toEqual([{ task_id: a, handle: 'pingpong', mode: 'start', reason: null }])
    expect((await inputRows(a)).map((row) => row.payload)).toMatchObject([
      { source: 'team', kind: 'mention', message_id: back.message.id },
    ])
    await waitIdle(a)
  })

  it('holds two agents that keep mentioning each other, unless the user is mentioned', async () => {
    const a = await newTask('Loop alpha')
    const b = await newTask('Loop beta')
    for (let turn = 0; turn <= TEAM_LOOP.exchanges; turn += 1) {
      const [from, to] = turn % 2 === 0 ? [a, b] : [b, a]
      await postTeamMessage({ kind: 'task', taskId: from }, `@${to === a ? 'loop' : 'loop-beta'} round ${String(turn)}`)
      await waitIdle(to)
    }
    const looped = await postTeamMessage({ kind: 'task', taskId: b }, '@loop and again')
    expect(looped.deliveries).toEqual([{ task_id: a, handle: 'loop', mode: 'held', reason: 'loop' }])
    const escalated = await postTeamMessage({ kind: 'task', taskId: b }, '@loop @user we are going in circles')
    expect(modes(escalated)).toEqual({ [a]: 'start' })
    await waitIdle(a)
  })

  it('holds messages from agents after a burst, while the user still gets through', async () => {
    const target = await newTask('Burst target')
    const authors = await Promise.all(
      Array.from({ length: TEAM_BURST.deliveries + 1 }, async (_, i) => newTask(`Burst author ${String(i)}`)),
    )
    const results: TeamPosted[] = []
    for (const author of authors) {
      results.push(await postTeamMessage({ kind: 'task', taskId: author }, '@burst status?'))
      await waitIdle(target)
    }
    expect(results.slice(0, -1).every((posted) => modes(posted)[target] === 'start')).toBe(true)
    expect(results.at(-1)?.deliveries).toEqual([{ task_id: target, handle: 'burst', mode: 'held', reason: 'burst' }])
    expect((await inputPreface(target))?.count).toBe(1)
    const fromUser = await postTeamMessage({ kind: 'user' }, '@burst over to you')
    expect(modes(fromUser)).toEqual({ [target]: 'start' })
    await waitIdle(target)
  })

  it('audits every post and what it did for each task', async () => {
    const target = await newTask('Audited target')
    const posted = await postTeamMessage({ kind: 'user' }, '@audited ship it')
    await waitIdle(target)
    await auditEvents.settled()
    expect(await auditEvents.latest('team.message_posted')).toMatchObject({
      actor: 'user',
      subject_type: 'team',
      subject_id: String(posted.message.id),
      detail: { author: 'user', text: '@audited ship it', mentions: ['audited'] },
    })
    const [latest] = await deliveryAudits()
    expect(latest).toMatchObject({
      actor: 'system',
      subject_type: 'task',
      subject_id: target,
      summary: 'Team message from user started a turn of task "Audited target"',
      detail: { mode: 'start', message_id: String(posted.message.id) },
    })
  })

  it('queues an @ea mention in the EA inbox, but not the EA mentioning itself', async () => {
    const author = await newTask('Deploy asker')
    const posted = await postTeamMessage(
      { kind: 'task', taskId: author },
      '@ea can you tell the user the deploy is out?',
    )
    const due = await eaInbox.due(new Date(Date.now() + 1000).toISOString(), 50, ['team_mention'])
    expect(due.at(-1)).toMatchObject({
      kind: 'team_mention',
      source: '@deploy',
      task_id: author,
      body: posted.message.text,
      urgent: true,
      message_id: posted.message.id,
    })
    await app.request('/api/team/messages', {
      method: 'POST',
      headers: { ...LOCAL, ...EA_AUTH },
      body: JSON.stringify({ text: '@ea noted' }),
    })
    const after = await eaInbox.due(new Date(Date.now() + 1000).toISOString(), 50, ['team_mention'])
    expect(after).toHaveLength(due.length)
  })

  it('sends the EA reply to a mention only to the agent that asked, at its next step', async () => {
    const asker = await newTask('Merge asker')
    const bystander = await newTask('Merge bystander')
    await sql`UPDATE task SET updated_at = ${new Date().toISOString()} WHERE id = ${bystander}`
    const asked = await postTeamMessage({ kind: 'task', taskId: asker }, '@ea may I merge my PR?')
    await waitIdle(asker)
    await busy(asker)
    const reply = async (body: unknown, via = true) =>
      app.request('/api/team/messages', {
        method: 'POST',
        headers: via ? { ...LOCAL, ...EA_AUTH } : LOCAL,
        body: JSON.stringify(body),
      })
    const response = await reply({ text: 'The user decides merges; I have asked them.', reply_to: asked.message.id })
    const posted = ((await response.json()) as { data: TeamPosted }).data
    expect(posted.message).toMatchObject({
      author_kind: 'ea',
      text: '@merge The user decides merges; I have asked them.',
    })
    expect(posted.deliveries).toEqual([{ task_id: asker, handle: 'merge', mode: 'next', reason: null }])
    expect(priorities(asker)).not.toContain('now')
    await auditEvents.settled()
    expect(await auditEvents.latest('team.message_posted')).toMatchObject({
      detail: { reply_to: String(asked.message.id) },
    })
    await release(asker)
    const idle = (
      (await (await reply({ text: '@merge yes', reply_to: asked.message.id })).json()) as { data: TeamPosted }
    ).data
    expect(modes(idle)).toEqual({ [asker]: 'start' })
    await waitIdle(asker)
    const refused = async (body: unknown, status: number, text: RegExp, via = true) => {
      const res = await reply(body, via)
      expect(res.status).toBe(status)
      expect(await res.text()).toMatch(text)
    }
    await refused({ text: '@all heads up', reply_to: asked.message.id }, 400, /@all needs a post the user agreed to/)
    await refused({ text: '@merge-bystander look', reply_to: asked.message.id }, 400, /@merge-bystander/)
    await refused({ text: 'hi', reply_to: asked.message.id }, 400, /Only the EA/, false)
    const plain = await postTeamMessage({ kind: 'task', taskId: asker }, 'no mention here')
    await refused({ text: 'hi', reply_to: plain.message.id }, 400, /did not mention @ea/)
    await refused({ text: 'hi', reply_to: 999_999 }, 404, /No group chat message/)
  })

  it('leaves held team messages alone when a wake task ends a turn', async () => {
    const target = await newTask('Held wake target')
    const author = await newTask('Held author')
    await sql`UPDATE task SET updated_at = ${new Date().toISOString()} WHERE id = ${target}`
    await postTeamMessage({ kind: 'task', taskId: author }, '@all fyi the schema changed')
    await runTurn(target, 'Carry on')
    await waitIdle(target)
    expect(turnsOf(target)).toHaveLength(1)
    expect(turnsOf(target)[0]?.text).toContain('fyi the schema changed')
    expect(isRunning(target)).toBe(false)
  })
})

describe('team routes', () => {
  it('pages earlier messages before an id, oldest first', async () => {
    const posted = []
    for (const text of ['one', 'two', 'three', 'four']) {
      posted.push(await postTeamMessage({ kind: 'user' }, `page ${text}`))
    }
    const before = posted[3]?.message.id ?? 0
    const listed = await app.request(`/api/team/messages?before=${String(before)}&limit=2`, { headers: LOCAL })
    const body = (await listed.json()) as { data: { text: string }[] }
    expect(body.data.map((m) => m.text)).toEqual(['page two', 'page three'])
  })

  it('lists messages after an id and the roster with handles', async () => {
    const id = await newTask('Roster member')
    const first = await postTeamMessage({ kind: 'user' }, 'first')
    await postTeamMessage({ kind: 'user' }, 'second')
    const listed = await app.request(`/api/team/messages?after=${String(first.message.id)}`, { headers: LOCAL })
    const body = (await listed.json()) as { data: { text: string }[] }
    expect(body.data.map((m) => m.text)).toEqual(['second'])
    const roster = (await (await app.request('/api/team/members', { headers: LOCAL })).json()) as {
      data: { task_id: string; handle: string }[]
    }
    expect(roster.data.find((member) => member.task_id === id)?.handle).toBe('roster')
  })

  it('resumes the stream with missed messages, and resets after a gap too long to fill', async () => {
    const opening = async (after: number) => {
      const res = await app.request(`/api/team/stream?after=${String(after)}`, { headers: LOCAL })
      const body: ReadableStream<Uint8Array> | null = res.body
      const reader = body?.getReader()
      const chunk = await reader?.read()
      await reader?.cancel()
      const lines = new TextDecoder().decode(chunk?.value).split('\n')
      const field = (name: string) =>
        lines
          .find((line) => line.startsWith(`${name}:`))
          ?.slice(name.length + 1)
          .trim()
      return { event: field('event'), data: JSON.parse(field('data') ?? '[]') as { id: number }[] }
    }
    const seen = await postTeamMessage({ kind: 'user' }, 'seen')
    const missed = await postTeamMessage({ kind: 'user' }, 'missed')
    const resumed = await opening(seen.message.id)
    expect(resumed.event).toBe('backlog')
    expect(resumed.data.map((m) => m.id)).toEqual([missed.message.id])
    const flood = { author_kind: 'user' as const, author_task_id: null, author_handle: null, mentions: [] }
    for (let i = 0; i < 501; i++) {
      await teamMessages.insert({ ...flood, text: `flood ${String(i)}` })
    }
    const reset = await opening(seen.message.id)
    expect(reset.event).toBe('reset')
    expect(reset.data).toHaveLength(50)
  })
})
