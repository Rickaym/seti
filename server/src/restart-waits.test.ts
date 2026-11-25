import { randomUUID } from 'node:crypto'
import { timedOutMessage } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { messages, sql, tasks } from './db.js'
import { callHash, grantOnce, takeGrant } from './permission-grants.js'
import { canUseToolFor } from './permission-requests.js'
import { answerPermission } from './permission-rules.js'
import { resumePermissionTimeouts } from './permission-timeout.js'
import { answerQuestions } from './question-answers.js'
import { askQuestions } from './questions.js'
import { markRestartCut } from './restart-resume.js'
import { stopForRestart } from './restart-state.js'
import { keepLeftoverRequests, settleLeftoversOnTurnStart } from './restart-waits.js'
import { runTurn } from './runner.js'
import { auditEvents } from './store/audit.js'
import { permissionRequests } from './store/permissions.js'
import { questions } from './store/questions.js'
import { restartCuts } from './store/restart.js'
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

/** A task whose turn was running, and waiting on the user, when Seti stopped. */
async function cutTask(): Promise<string> {
  count += 1
  const id = `late-${String(count)}`
  await tasks.insert({ id, title: `Late ${String(count)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  await tasks.setSession(id, { sessionId: `session-${id}`, permissionMode: 'default', model: 'haiku' })
  await tasks.setStatus(id, 'running', null)
  return id
}

const YES_NO = [
  { label: 'Yes', description: null },
  { label: 'No', description: null },
]

async function ask(taskId: string, prompts: readonly string[], kind: 'yes_no' | 'secret' = 'yes_no') {
  const groupId = randomUUID()
  return questions.open(
    prompts.map((prompt, position) => ({
      id: randomUUID(),
      group_id: groupId,
      task_id: taskId,
      subagent_id: null,
      tool_use_id: 'toolu_late',
      position,
      header: prompt.split(' ')[0] ?? prompt,
      prompt,
      kind,
      multi: false,
      options: kind === 'secret' ? [] : YES_NO,
    })),
  )
}

const DEPLOY = { command: 'make deploy', description: 'Deploy to staging' }

async function request(taskId: string, input: Record<string, unknown> = DEPLOY) {
  return permissionRequests.open({
    id: randomUUID(),
    task_id: taskId,
    tool_name: 'Bash',
    kind: 'tool',
    summary: 'make deploy',
    input: JSON.stringify(input),
    reason: null,
    suggestions: [],
    editable: true,
    input_hash: callHash('Bash', input),
    timeout_minutes: 60,
  })
}

/** What startup does about the turns and requests a restart left behind. */
async function restart(): Promise<{ notify: string[]; resume: { taskId: string }[] }> {
  await keepLeftoverRequests()
  return markRestartCut()
}

const sent = async (id: string) =>
  (await messages.page(id, 100)).messages.flatMap((row) => (row.kind === 'prompt' ? [row.payload] : []))

const statuses = async (asked: readonly { id: string }[]) =>
  (await questions.byIds(asked.map((q) => q.id))).map((q) => q.status)

async function taskOf(id: string) {
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('no task')
  }
  return task
}

const toolOptions = () => ({ signal: new AbortController().signal, toolUseID: 'toolu_again', requestId: 'req_again' })

describe('a question a restart cut off', () => {
  it('stays open, and its answer resumes the agent in its own session', async () => {
    const id = await cutTask()
    const asked = await ask(id, ['Deploy to staging?', 'Tag the release?'])
    await restartCuts.record([{ task_id: id, kind: 'user', background: 1 }])
    expect(await restart()).toEqual({ notify: [], resume: [] })
    expect(await statuses(asked)).toEqual(['open', 'open'])
    expect(await taskOf(id)).toMatchObject({ status: 'interrupted', blocked: 'Asks 2 questions: Deploy to staging?' })

    const [deploy, tag] = asked
    const first = await answerQuestions({
      items: [{ id: deploy?.id ?? '', action: 'answer', selected: ['Yes'], other: null }],
    })
    expect(first).toMatchObject({ answered: 1, resumed: [] })
    expect(await sent(id)).toEqual([])
    const second = await answerQuestions({
      items: [{ id: tag?.id ?? '', action: 'answer', selected: [], other: 'Only after the smoke test' }],
    })
    expect(second.resumed).toEqual([{ task_id: id, task_title: (await taskOf(id)).title }])
    await waitIdle(id)

    const [prompt] = await sent(id)
    expect(prompt).toMatchObject({ from: 'Seti' })
    expect(prompt?.text).toContain("Seti restarted while you waited for the user's answers")
    expect(prompt?.text).toContain('- Deploy to staging?\n  Answer: Yes')
    expect(prompt?.text).toContain('- Tag the release?\n  Answer: Only after the smoke test')
    expect(prompt?.text).toContain('background commands and subagents you had started were stopped')
    expect(sdk.turns.filter((turn) => turn.task === id)).toMatchObject([{ resume: `session-${id}` }])
    expect(await statuses(asked)).toEqual(['answered', 'answered'])
    expect((await taskOf(id)).blocked).toBeNull()
    await auditEvents.settled()
    const [audited] = await sql<{ summary: string }[]>`SELECT summary FROM audit_event
      WHERE kind = 'task.resumed_after_restart' AND subject_id = ${id}`
    expect(audited?.summary).toContain('with the answers given after a restart')
  })

  it('resumes the agent to go on by itself when the user dismisses it', async () => {
    const id = await cutTask()
    const asked = await ask(id, ['Deploy to staging?'])
    await restart()
    const result = await answerQuestions({ items: [{ id: asked[0]?.id ?? '', action: 'dismiss' }] })
    expect(result).toMatchObject({ dismissed: 1, resumed: [{ task_id: id }] })
    await waitIdle(id)
    expect((await sent(id))[0]?.text).toContain('The user dismissed your questions without answering')
  })

  it('expires when it asked for a secret, and when the agent goes on without the answer', async () => {
    const secret = await cutTask()
    const token = await ask(secret, ['Token for the registry'], 'secret')
    const moved = await cutTask()
    const asked = await ask(moved, ['Deploy to staging?'])
    const pending = await request(moved)
    expect((await restart()).resume.map((each) => each.taskId)).toEqual([secret])
    expect(await statuses(token)).toEqual(['expired'])
    expect(await statuses(asked)).toEqual(['open'])

    await runTurn(moved, 'Skip the deploy and write the notes')
    await waitIdle(moved)
    await vi.waitFor(async () => {
      expect(await statuses(asked)).toEqual(['expired'])
      expect((await permissionRequests.get(pending.id))?.state).toBe('cancelled')
      expect((await taskOf(moved)).blocked).toBeNull()
    })
    await sql`UPDATE task SET status = 'idle' WHERE id = ${secret}`
  })
})

describe('a permission request a restart cut off', () => {
  it('stays pending; allowing it resumes the agent and lets that one call run once', async () => {
    const id = await cutTask()
    const pending = await request(id)
    expect(await restart()).toEqual({ notify: [], resume: [] })
    expect((await permissionRequests.get(pending.id))?.state).toBe('pending')
    expect(await taskOf(id)).toMatchObject({ status: 'interrupted', blocked: 'Asks to use Bash: make deploy' })

    const edit = answerPermission(await taskOf(id), pending.id, { decision: 'allow', fields: { command: 'make all' } })
    await expect(edit).rejects.toThrow(/cannot be edited/)
    const settled = await answerPermission(await taskOf(id), pending.id, { decision: 'allow' })
    expect(settled.state).toBe('allowed')
    await waitIdle(id)
    const [prompt] = await sent(id)
    expect(prompt).toMatchObject({ from: 'Seti' })
    expect(prompt?.text).toContain("Seti restarted while this call waited for the user's permission")
    expect(prompt?.text).toContain('Bash (make deploy). The user has allowed it since.')
    expect(sdk.turns.filter((turn) => turn.task === id)).toMatchObject([{ resume: `session-${id}` }])

    const canUseTool = canUseToolFor(id, new AbortController().signal)
    const other = new AbortController()
    const different = canUseTool('Bash', { command: 'make clean' }, { ...toolOptions(), signal: other.signal })
    await vi.waitFor(async () => {
      expect(await permissionRequests.pending(id)).toHaveLength(1)
    })
    other.abort()
    expect((await different).result).toMatchObject({ behavior: 'deny' })

    const { result: again } = await canUseTool(
      'Bash',
      { description: DEPLOY.description, command: DEPLOY.command },
      toolOptions(),
    )
    expect(again).toEqual({
      behavior: 'allow',
      updatedInput: { description: DEPLOY.description, command: DEPLOY.command },
    })
    expect(await permissionRequests.pending(id)).toEqual([])

    const third = new AbortController()
    const repeat = canUseTool('Bash', DEPLOY, { ...toolOptions(), signal: third.signal })
    await vi.waitFor(async () => {
      expect(await permissionRequests.pending(id)).toHaveLength(1)
    })
    third.abort()
    expect((await repeat).result).toMatchObject({ behavior: 'deny' })
  })

  it('tells the agent when the user denies it, and grants nothing', async () => {
    const id = await cutTask()
    const pending = await request(id)
    await restart()
    await answerPermission(await taskOf(id), pending.id, { decision: 'deny', message: 'Not on a Friday' })
    await waitIdle(id)
    expect((await sent(id))[0]?.text).toContain('The user has denied it since and said: Not on a Friday.')
    expect(takeGrant(id, callHash('Bash', DEPLOY))).toBe(false)
  })

  it('is denied when its time runs out, which resumes the agent with the reason', async () => {
    const id = await cutTask()
    const pending = await request(id)
    await permissionRequests.retime(pending.id, new Date(Date.now() - 1000).toISOString())
    await restart()
    await resumePermissionTimeouts()
    await vi.waitFor(async () => {
      expect(await permissionRequests.get(pending.id)).toMatchObject({ state: 'denied', timed_out: true })
    })
    await vi.waitFor(async () => {
      expect((await sent(id))[0]?.text).toContain(`Bash (make deploy). ${timedOutMessage(0)}`)
    })
    await waitIdle(id)
    expect(takeGrant(id, callHash('Bash', DEPLOY))).toBe(false)
  })
})

describe('one-time grants', () => {
  it('name a call whatever the order of its fields, and never another call', () => {
    expect(callHash('Bash', { a: 1, b: { c: [1, 2], d: 'x' } })).toBe(
      callHash('Bash', { b: { d: 'x', c: [1, 2] }, a: 1 }),
    )
    expect(callHash('Bash', { a: 1 })).not.toBe(callHash('Bash', { a: 2 }))
    expect(callHash('Bash', { a: 1 })).not.toBe(callHash('Write', { a: 1 }))
  })

  it('work once, for their own agent, and run out', () => {
    grantOnce('grant-a', 'hash', 1000)
    expect(takeGrant('grant-b', 'hash', 1000)).toBe(false)
    expect(takeGrant('grant-a', 'hash', 2000)).toBe(true)
    expect(takeGrant('grant-a', 'hash', 2000)).toBe(false)
    grantOnce('grant-a', 'hash', 1000)
    expect(takeGrant('grant-a', 'hash', 1000 + 16 * 60_000)).toBe(false)
  })
})

describe('stopping Seti while an agent waits on the user', () => {
  it('ends the calls and leaves the question and the request open', async () => {
    const id = await cutTask()
    const session = new AbortController()
    const input = {
      questions: [{ question: 'Deploy to staging?', header: 'Deploy', multiSelect: false, options: YES_NO }],
    }
    const asking = askQuestions(id, input, toolOptions(), session.signal)
    const allowing = canUseToolFor(id, session.signal)('Bash', DEPLOY, toolOptions())
    await vi.waitFor(async () => {
      expect(await questions.openList(id)).toHaveLength(1)
      expect(await permissionRequests.pending(id)).toHaveLength(1)
    })
    stopForRestart()
    session.abort()
    expect(await asking).toMatchObject({ behavior: 'deny', interrupt: true })
    expect((await allowing).result).toMatchObject({ behavior: 'deny', interrupt: true })
    expect(await questions.openList(id)).toHaveLength(1)
    expect(await permissionRequests.pending(id)).toHaveLength(1)
  })
})
