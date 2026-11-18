import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { updateAutoArchive } from './archive.js'
import { messages, sql, tasks } from './db.js'
import {
  BACKGROUND_NOTE,
  HELD_REASON,
  markRestartCut,
  noteTurnFinished,
  RESUME_LIMIT,
  RESUME_PROMPT,
  RESUME_WINDOW_MS,
  RESUMED_NOTE,
  resumeInterrupted,
  type Resume,
} from './restart-resume.js'
import { settleLeftoversOnTurnStart } from './restart-waits.js'
import { runTurn } from './runner.js'
import { auditEvents } from './store/audit.js'
import { changeRequests } from './store/change-requests.js'
import { permissionRequests } from './store/permissions.js'
import { questions } from './store/questions.js'
import { restartCuts } from './store/restart.js'
import { refreshBlocked } from './task-blocked.js'
import { waitIdle } from './wait-idle.js'

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  const turns: { task: string; text: string; resume: string | undefined }[] = []
  const fake = new FakeSdk(function* ({ text, session }) {
    turns.push({ task: session.options.env?.SETI_TASK_ID ?? '', text, resume: session.options.resume })
    yield fakeResult()
  })
  return { turns, fake }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.fake.query,
}))

settleLeftoversOnTurnStart()

let count = 0

/** A task whose turn was running when Seti stopped, with a session to resume. */
async function cutTask(): Promise<string> {
  count += 1
  const id = `resume-${String(count)}`
  await tasks.insert({ id, title: `Resume ${String(count)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  await tasks.setSession(id, { sessionId: `session-${id}`, permissionMode: 'default', model: 'haiku' })
  await tasks.setStatus(id, 'running', null)
  return id
}

const rows = async (id: string) => (await messages.page(id, 100)).messages

const prompts = async (id: string) => (await rows(id)).flatMap((row) => (row.kind === 'prompt' ? [row.payload] : []))

const notes = async (id: string) => (await rows(id)).flatMap((row) => (row.kind === 'seti' ? [row.payload] : []))

async function audited(id: string, kind = 'task.resumed_after_restart'): Promise<Record<string, unknown>[]> {
  await auditEvents.settled()
  const found = await sql<{ detail: string }[]>`SELECT detail FROM audit_event
    WHERE kind = ${kind} AND subject_id = ${id} AND actor = 'system' ORDER BY id`
  return found.map((row) => JSON.parse(row.detail) as Record<string, unknown>)
}

const openQuestion = async (taskId: string) =>
  questions.open([
    {
      id: randomUUID(),
      group_id: randomUUID(),
      task_id: taskId,
      subagent_id: null,
      tool_use_id: 'toolu_cut',
      position: 0,
      header: 'Deploy',
      prompt: 'Deploy to staging?',
      kind: 'yes_no',
      multi: false,
      options: [
        { label: 'Yes', description: null },
        { label: 'No', description: null },
      ],
    },
  ])

const ids = (resumes: readonly Resume[]) => resumes.map((each) => each.taskId)

describe('resuming after a restart', () => {
  it('resumes a cut-off agent in its own session once, marks the transcript and audits it', async () => {
    const id = await cutTask()
    const cut = await markRestartCut()
    expect(cut).toEqual({ notify: [], resume: [{ taskId: id, kind: null, background: 0 }] })
    expect(await tasks.get(id)).toMatchObject({ status: 'interrupted', unseen: false })
    await resumeInterrupted([...cut.resume, ...cut.resume])
    await waitIdle(id)
    await resumeInterrupted(cut.resume)
    await waitIdle(id)
    expect(await prompts(id)).toMatchObject([{ text: RESUME_PROMPT, from: 'Seti' }])
    expect(await notes(id)).toEqual([{ error: RESUMED_NOTE, resumed: true }])
    expect(sdk.turns.filter((turn) => turn.task === id)).toMatchObject([{ resume: `session-${id}` }])
    expect(await audited(id)).toMatchObject([{ prompt: RESUME_PROMPT, turn: 'unknown', background: 0 }])
  })

  it('tells only an agent that had background work that the restart stopped it', async () => {
    const id = await cutTask()
    await restartCuts.record([{ task_id: id, kind: 'wake', background: 2 }])
    const cut = await markRestartCut()
    expect(cut.resume).toEqual([{ taskId: id, kind: 'wake', background: 2 }])
    expect(await restartCuts.recorded()).toEqual(new Map())
    await resumeInterrupted(cut.resume)
    await waitIdle(id)
    expect(await prompts(id)).toMatchObject([{ text: `${RESUME_PROMPT} ${BACKGROUND_NOTE}` }])
    expect(await audited(id)).toMatchObject([{ turn: 'wake', background: 2 }])
  })

  it('resumes turns the user waits on first, then wake-ups, then updates', async () => {
    const [updates, wake, user] = [await cutTask(), await cutTask(), await cutTask()]
    await restartCuts.record([
      { task_id: updates, kind: 'updates', background: 0 },
      { task_id: wake, kind: 'wake', background: 0 },
      { task_id: user, kind: 'user', background: 0 },
    ])
    const cut = await markRestartCut()
    expect(ids(cut.resume)).toEqual([user, wake, updates])
    await sql`UPDATE task SET status = 'idle' WHERE id = ANY(${[updates, wake, user]})`
  })

  it('leaves agents the user stopped or archived, and those that wait on an answer', async () => {
    const stopped = await cutTask()
    await tasks.setStatus(stopped, 'stopped', null)
    const archived = await cutTask()
    await sql`UPDATE task SET archived_at = ${new Date().toISOString()} WHERE id = ${archived}`
    const asked = await cutTask()
    const [question] = await openQuestion(asked)
    await refreshBlocked(asked)
    const permission = await cutTask()
    const request = { tool_name: 'Bash', kind: 'tool', summary: 'make deploy', input: '{}', reason: null } as const
    await permissionRequests.open({
      id: randomUUID(),
      task_id: permission,
      ...request,
      suggestions: [],
      editable: false,
    })
    await refreshBlocked(permission)
    const asking = await cutTask()
    await tasks.endTurn(asking, { status: 'idle', last_error: null, asking: true, closing_line: null })

    const cut = await markRestartCut()
    expect(cut).toEqual({ notify: [archived], resume: [] })
    expect(await tasks.get(stopped)).toMatchObject({ status: 'stopped' })
    expect(await tasks.get(asking)).toMatchObject({ status: 'idle', asking: true })
    expect(await tasks.get(asked)).toMatchObject({
      status: 'interrupted',
      blocked: 'Asks a question: Deploy to staging?',
    })
    expect(await tasks.get(permission)).toMatchObject({
      status: 'interrupted',
      blocked: 'Asks to use Bash: make deploy',
    })
    expect((await questions.byIds([question?.id ?? ''])).map((q) => q.status)).toEqual(['open'])
    expect(await permissionRequests.pending(permission)).toHaveLength(1)
    await resumeInterrupted([{ taskId: archived, kind: null, background: 0 }])
    for (const id of [stopped, archived, asked, permission, asking]) {
      expect(await prompts(id)).toEqual([])
      expect(await audited(id)).toEqual([])
    }
    await questions.expireGroup(question?.group_id ?? '')
    await sql`UPDATE permission_request SET state = 'cancelled' WHERE task_id = ${permission}`
  })

  it('resumes an agent whose only open request does not hold its turn', async () => {
    const id = await cutTask()
    await changeRequests.open({
      id: randomUUID(),
      task_id: id,
      change: { kind: 'allow_host', host: 'fixtures.example.com', port: 443 },
      reason: 'The tests download fixtures from there.',
      profile_id: 'default',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    })
    await refreshBlocked(id)
    expect(ids((await markRestartCut()).resume)).toEqual([id])
    expect((await tasks.get(id))?.blocked).toMatch(/^Asks for /)
    await sql`UPDATE task SET status = 'idle' WHERE id = ${id}`
  })

  it('resumes nothing while Resume after restart is off', async () => {
    await updateAutoArchive({ resume_after_restart: false })
    const id = await cutTask()
    expect(await markRestartCut()).toEqual({ notify: [id], resume: [] })
    expect(await tasks.get(id)).toMatchObject({ status: 'interrupted', unseen: true })
    expect(await prompts(id)).toEqual([])
    await updateAutoArchive({ resume_after_restart: true })
  })

  it('starts a few sessions close together and the next few after a longer gap', async () => {
    const cut: Resume[] = []
    for (let n = 0; n < 7; n += 1) {
      cut.push({ taskId: await cutTask(), kind: 'user', background: 0 })
    }
    await markRestartCut()
    const waits: number[] = []
    const wait = async (ms: number) => {
      waits.push(ms)
      return Promise.resolve()
    }
    await resumeInterrupted(cut, { group: 3, staggerMs: 2000, groupGapMs: 20_000, wait })
    expect(waits).toEqual([2000, 2000, 20_000, 2000, 2000, 20_000])
    for (const each of cut) {
      await waitIdle(each.taskId)
      expect(await prompts(each.taskId)).toHaveLength(1)
    }
  })
})

describe('an agent that restarts keep cutting off', () => {
  /** A restart cuts the agent's turn off again, and startup resumes it if it still may. */
  async function restartOnce(id: string, at = Date.now()): Promise<{ notify: string[]; resume: Resume[] }> {
    await tasks.setStatus(id, 'running', null)
    const cut = await markRestartCut(at)
    await resumeInterrupted(cut.resume)
    await waitIdle(id)
    return cut
  }

  it('is not resumed again after the limit, and shows why in Needs you', async () => {
    const id = await cutTask()
    for (let n = 0; n < RESUME_LIMIT; n += 1) {
      expect(ids((await restartOnce(id)).resume)).toEqual([id])
    }
    expect(await restartOnce(id)).toEqual({ notify: [id], resume: [] })
    expect(await tasks.get(id)).toMatchObject({ status: 'interrupted', unseen: true, blocked: HELD_REASON })
    expect(await prompts(id)).toHaveLength(RESUME_LIMIT)
    expect(await audited(id, 'task.resume_held')).toMatchObject([{ resumes: RESUME_LIMIT }])

    await runTurn(id, 'Carry on')
    await waitIdle(id)
    await vi.waitFor(async () => {
      expect((await tasks.get(id))?.blocked).toBeNull()
    })
    expect(ids((await restartOnce(id)).resume)).toEqual([id])
  })

  it('counts from zero again once the agent finishes a turn, or the window has passed', async () => {
    const finishing = await cutTask()
    for (let n = 0; n < RESUME_LIMIT; n += 1) {
      await restartOnce(finishing)
    }
    await noteTurnFinished(finishing, 'error')
    await noteTurnFinished(finishing, 'idle')
    expect(ids((await restartOnce(finishing)).resume)).toEqual([finishing])

    const slow = await cutTask()
    for (let n = 0; n < RESUME_LIMIT; n += 1) {
      await restartOnce(slow)
    }
    expect(ids((await restartOnce(slow, Date.now() + RESUME_WINDOW_MS + 1000)).resume)).toEqual([slow])
  })
})
