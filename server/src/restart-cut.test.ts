import { describe, expect, it, vi } from 'vitest'
import { LiveSession } from './agent-session.js'
import { messages, sql, tasks } from './db.js'
import { cutRunningTurns } from './restart-cut.js'
import { BACKGROUND_NOTE, markRestartCut, RESUME_PROMPT, resumeInterrupted } from './restart-resume.js'
import { isRunning, onTurnEnd, runTurn, sessionState } from './runner.js'
import { auditEvents } from './store/audit.js'
import { restartCuts } from './store/restart.js'
import { waitIdle } from './wait-idle.js'

/** A turn that works until it is interrupted, then one that finishes for the resume message. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, aborted, fakeAssistant, fakeBackground, fakeResult } = await import('./fake-sdk.js')
  const fake = new FakeSdk(async function* ({ text, signal }) {
    if (text.includes('hold')) {
      yield fakeAssistant('Working on it.')
      if (text.includes('background')) {
        yield fakeBackground('shell-1', 'shell-2')
      }
      await aborted(signal)
      return
    }
    yield fakeResult()
  })
  return { fake }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.fake.query,
}))

const ended: [string, string][] = []
onTurnEnd((taskId, status) => {
  ended.push([taskId, status])
})

async function workingTask(id: string, prompt: string): Promise<string> {
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  await runTurn(id, prompt)
  await vi.waitFor(() => {
    expect(sdk.fake.sessions.some((session) => session.current === prompt)).toBe(true)
  })
  return id
}

describe('a session notes what started its turn', () => {
  it('a written message, updates, or background work reporting back', () => {
    const session = new LiveSession([])
    session.send({ text: 'hello', images: [] }, 1)
    expect(session.turnKind).toBe('user')
    session.endTurn()
    session.send({ text: 'updates', images: [] }, 2, 'updates')
    expect(session.turnKind).toBe('updates')
    session.endTurn()
    expect(session.resumeWork()).toBe(true)
    expect(session.turnKind).toBe('wake')
  })
})

describe('stopping Seti', () => {
  it('records the running turns, ends them cleanly and leaves them for the next start', async () => {
    const plain = await workingTask('cut-plain', 'hold on')
    const busy = await workingTask('cut-busy', 'hold on with background work')
    await vi.waitFor(() => {
      expect(sessionState(busy).background).toBe(2)
    })
    const idle = 'cut-idle'
    await tasks.insert({ id: idle, title: idle, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    await runTurn(idle, 'finish at once')
    await waitIdle(idle)

    const turns = await cutRunningTurns(2000)
    expect(turns).toEqual([
      { task_id: plain, kind: 'user', background: 0 },
      { task_id: busy, kind: 'user', background: 2 },
    ])
    expect(sdk.fake.interrupted).toEqual(['hold on', 'hold on with background work'])
    const held = sdk.fake.sessions.filter((session) => session.prompts.some((text) => text.includes('hold')))
    expect(held.map((session) => session.closed)).toEqual([true, true])
    expect(isRunning(plain)).toBe(false)
    expect(isRunning(busy)).toBe(false)
    expect(ended.filter(([id]) => id !== idle)).toEqual([])
    expect((await tasks.get(plain))?.status).toBe('running')
    expect((await tasks.get(idle))?.status).toBe('idle')
    expect(await restartCuts.recorded()).toEqual(
      new Map([
        [plain, { task_id: plain, kind: 'user', background: 0 }],
        [busy, { task_id: busy, kind: 'user', background: 2 }],
      ]),
    )
    await auditEvents.settled()
    const [stopping] = await sql<{ summary: string }[]>`SELECT summary FROM audit_event
      WHERE kind = 'system.stopping' ORDER BY id DESC LIMIT 1`
    expect(stopping?.summary).toBe('Seti is stopping and cut 2 running turns')
  })

  it('the next start resumes them, naming background work only where there was some', async () => {
    const cut = await markRestartCut()
    expect(cut.notify).toEqual([])
    expect(cut.resume).toHaveLength(2)
    expect(cut.resume).toEqual(
      expect.arrayContaining([
        { taskId: 'cut-plain', kind: 'user', background: 0 },
        { taskId: 'cut-busy', kind: 'user', background: 2 },
      ]),
    )
    await resumeInterrupted(cut.resume, { group: 3, staggerMs: 0, groupGapMs: 0 })
    await waitIdle('cut-plain')
    await waitIdle('cut-busy')
    const told = async (id: string) =>
      (await messages.page(id, 100)).messages.flatMap((row) => (row.kind === 'prompt' ? [row.payload.text] : []))
    expect((await told('cut-plain')).at(-1)).toBe(RESUME_PROMPT)
    expect((await told('cut-busy')).at(-1)).toBe(`${RESUME_PROMPT} ${BACKGROUND_NOTE}`)
    expect(ended).toContainEqual(['cut-plain', 'idle'])
  })
})
