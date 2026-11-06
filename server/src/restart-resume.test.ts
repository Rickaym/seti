import { describe, expect, it, vi } from 'vitest'
import { updateAutoArchive } from './archive.js'
import { messages, sql, tasks } from './db.js'
import { markRestartCut, RESUME_PROMPT, resumeInterrupted } from './restart-resume.js'
import { auditEvents } from './store/audit.js'
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

const prompts = async (id: string) =>
  (await messages.page(id, 100)).messages.flatMap((row) => (row.kind === 'prompt' ? [row.payload] : []))

async function audited(id: string): Promise<number> {
  await auditEvents.settled()
  const [row] = await sql<{ count: number }[]>`SELECT COUNT(*) AS count FROM audit_event
    WHERE kind = 'task.resumed_after_restart' AND subject_id = ${id} AND actor = 'system'`
  return row?.count ?? 0
}

describe('resuming after a restart', () => {
  it('sends a cut-off agent one message in its own session, once, and audits it', async () => {
    const id = await cutTask()
    const cut = await markRestartCut()
    expect(cut).toEqual({ notify: [], resume: [id] })
    expect(await tasks.get(id)).toMatchObject({ status: 'interrupted', unseen: false })
    await resumeInterrupted([id, id], 0)
    await waitIdle(id)
    await resumeInterrupted(cut.resume, 0)
    await waitIdle(id)
    expect(await prompts(id)).toMatchObject([{ text: RESUME_PROMPT, from: 'Seti' }])
    expect(sdk.turns.filter((turn) => turn.task === id)).toMatchObject([{ resume: `session-${id}` }])
    expect(await audited(id)).toBe(1)
  })

  it('leaves agents that waited on the user, asked a question or were archived for the user', async () => {
    const blocked = await cutTask()
    await tasks.setBlocked(blocked, 'Asks to use Bash: make deploy')
    const archived = await cutTask()
    await sql`UPDATE task SET archived_at = ${new Date().toISOString()} WHERE id = ${archived}`
    const asking = await cutTask()
    await tasks.endTurn(asking, { status: 'idle', last_error: null, asking: true, closing_line: null })
    const cut = await markRestartCut()
    expect(cut.resume).toEqual([])
    expect(new Set(cut.notify)).toEqual(new Set([archived, blocked]))
    expect(await tasks.get(blocked)).toMatchObject({ status: 'interrupted', unseen: true, blocked: null })
    expect(await tasks.get(asking)).toMatchObject({ status: 'idle', asking: true })
    await resumeInterrupted([...cut.resume, archived], 0)
    for (const id of [blocked, archived, asking]) {
      expect(await prompts(id)).toEqual([])
      expect(await audited(id)).toBe(0)
    }
  })

  it('resumes nothing while Resume after restart is off', async () => {
    await updateAutoArchive({ resume_after_restart: false })
    const id = await cutTask()
    expect(await markRestartCut()).toEqual({ notify: [id], resume: [] })
    expect(await tasks.get(id)).toMatchObject({ status: 'interrupted', unseen: true })
    expect(await prompts(id)).toEqual([])
    await updateAutoArchive({ resume_after_restart: true })
  })
})
