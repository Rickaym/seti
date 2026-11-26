import { randomUUID } from 'node:crypto'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { EA_ASK_HEADER, type EaAsk, type PendingRequests, type PermissionRequest, type Task } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { asAgent, asMod } from './access.js'
import { createApp } from './app.js'
import { sql, tasks } from './db.js'
import { answerPermission } from './permission-rules.js'
import { endSession, runTurn } from './runner.js'
import { auditEvents } from './store/audit.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

/** `permit <command>` asks to run the command; `plan` asks to leave plan mode. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('./fake-sdk.js')
  const ask = async (canUseTool: CanUseTool, text: string, signal: AbortSignal) => {
    const options = { signal, toolUseID: 'toolu_1', requestId: 'req_1' }
    if (text === 'plan') {
      return canUseTool('ExitPlanMode', { plan: 'Step one' }, options)
    }
    return canUseTool('Bash', { command: text.replace(/^permit /, '') }, { ...options, decisionReason: 'Ask rule' })
  }
  const fake = new FakeSdk(async function* (turn) {
    const { canUseTool } = turn.session.options
    const result = canUseTool === undefined ? null : await ask(canUseTool, turn.text, turn.signal)
    yield fakeAssistant(JSON.stringify(result))
    yield fakeResult()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
const JSON_TYPE = { host: 'localhost', 'content-type': 'application/json' }
const created: string[] = []

async function send(method: string, path: string, auth: object, body?: unknown): Promise<Response> {
  return app.request(`/api${path}`, {
    method,
    headers: { ...JSON_TYPE, ...auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: T }).data
}

/** An agent waiting on the user to allow `prompt`'s call, and that request as the EA lists it. */
async function waiting(prompt: string): Promise<{ task: Task; request: PermissionRequest & { digest: string } }> {
  const id = `ea-authority-${String(created.length + 1)}-${String(Date.now())}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  created.push(id)
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('no task')
  }
  await runTurn(id, prompt)
  const request = await vi.waitFor(
    async () => {
      const pending = await data<PendingRequests>(await send('GET', `/requests?task_id=${id}`, EA_AUTH))
      const [held] = pending.permissions
      if (held === undefined) {
        throw new Error('No request waits yet')
      }
      return held
    },
    { interval: 10 },
  )
  return { task, request }
}

interface Said {
  decision?: 'allow' | 'deny'
  message?: string
  digest?: string
  tool?: string
  epoch?: string
  yesTurn?: number
  yesEpoch?: string
}

/** An EA question for the answer, asked in turn 4 of process e1, and the user's yes to it. */
async function yes(request: PermissionRequest & { digest: string }, said: Said = {}): Promise<number> {
  const args = {
    request: request.id,
    digest: said.digest ?? request.digest,
    decision: said.decision ?? 'allow',
    message: said.message ?? '',
  }
  const asked = await data<EaAsk>(
    await send('POST', '/ea/asks', EA_AUTH, {
      tool: said.tool ?? 'answer_question',
      args,
      summary: `${args.decision} request ${request.id.slice(0, 8)}`,
      key: `answer_question:${JSON.stringify(args)}:${randomUUID()}`,
      epoch: said.epoch ?? 'e1',
      turn: 4,
    }),
  )
  const body = { ids: [asked.id], epoch: said.yesEpoch ?? said.epoch ?? 'e1', turn: said.yesTurn ?? 5 }
  await data(await send('POST', '/ea/asks/confirm', EA_AUTH, body))
  return asked.id
}

const answer = async (
  task: Task,
  request: PermissionRequest,
  ask: number | null,
  body: object = { decision: 'allow' },
) =>
  send(
    'POST',
    `/tasks/${task.id}/permission-requests/${request.id}`,
    {
      ...EA_AUTH,
      ...(ask === null ? {} : { [EA_ASK_HEADER]: String(ask) }),
    },
    body,
  )

async function refused(res: Response, words: string): Promise<void> {
  expect(res.status).toBe(403)
  expect(((await res.json()) as { error: { detail: string } }).error.detail).toContain(words)
}

async function state(request: PermissionRequest): Promise<string> {
  const [row] = await sql<{ state: string }[]>`SELECT state FROM permission_request WHERE id = ${request.id}`
  return row?.state ?? 'gone'
}

afterAll(async () => {
  for (const id of created) {
    await endSession(id)
  }
})

describe('the EA answers a held call only on the user word', () => {
  it('allows once on a yes from the next turn, and audits that it acted on the user word', async () => {
    const { task, request } = await waiting('permit git push origin main')
    const ask = await yes(request)
    expect((await data<PermissionRequest>(await answer(task, request, ask))).state).toBe('allowed')
    await auditEvents.settled()
    const entry = await auditEvents.latest('task.permission_allowed')
    expect(entry?.summary).toMatch(/^On the user's word, the EA allowed Bash for task/)
    expect(entry?.detail).toMatchObject({ on_users_word: ask, request: request.id, via: 'ea' })
  })

  it('denies with the user message, and approves a plan', async () => {
    const denied = await waiting('permit rm -rf build')
    const no = await yes(denied.request, { decision: 'deny', message: 'use the staging bucket' })
    const res = await answer(denied.task, denied.request, no, { decision: 'deny', message: 'use the staging bucket' })
    expect((await data<PermissionRequest>(res)).message).toBe('use the staging bucket')
    const plan = await waiting('plan')
    const go = await yes(plan.request)
    expect((await data<PermissionRequest>(await answer(plan.task, plan.request, go))).state).toBe('allowed')
  })

  it('refuses without a yes, with another tool question, in the same turn, two turns on or after a restart', async () => {
    const { task, request } = await waiting('permit make deploy')
    await refused(await answer(task, request, null), "only on the user's own yes")
    await refused(await answer(task, request, await yes(request, { tool: 'delete_agent' })), "user's own yes")
    await refused(await answer(task, request, await yes(request, { yesTurn: 4 })), "user's own yes")
    await refused(await answer(task, request, await yes(request, { yesTurn: 6 })), "user's own yes")
    await refused(await answer(task, request, await yes(request, { yesEpoch: 'e2' })), "user's own yes")
    expect(await state(request)).toBe('pending')
  })

  it('uses a yes once, and not after its minute', async () => {
    const first = await waiting('permit npm publish')
    const ask = await yes(first.request)
    await data(await answer(first.task, first.request, ask))
    const second = await waiting('permit npm publish')
    await refused(await answer(second.task, second.request, ask), "user's own yes")
    const late = await yes(second.request)
    const old = new Date(Date.now() - 5 * 60_000).toISOString()
    await sql`UPDATE ea_ask SET decided_at = ${old} WHERE id = ${late}`
    await refused(await answer(second.task, second.request, late), "user's own yes")
    expect(await state(second.request)).toBe('pending')
  })

  it('refuses a yes to another decision, message or request, and a call that changed after the read-back', async () => {
    const { task, request } = await waiting('permit git push')
    await refused(await answer(task, request, await yes(request, { decision: 'deny' })), '(decision)')
    const told = { decision: 'deny', message: 'push to staging' }
    await refused(
      await answer(task, request, await yes(request, { decision: 'deny', message: 'no' }), told),
      '(message)',
    )
    await refused(await answer(task, request, await yes(request, { digest: 'a'.repeat(64) })), '(digest)')
    const ask = await yes(request)
    await sql`UPDATE permission_request SET input = ${'{"command": "git push --force"}'} WHERE id = ${request.id}`
    await refused(await answer(task, request, ask), '(digest)')
    expect(await state(request)).toBe('pending')
  })

  it('never always allows, keeps a rule for every agent, edits a call or allows one too long to read back', async () => {
    const { task, request } = await waiting('permit git status')
    for (const body of [
      { decision: 'always' },
      { decision: 'allow', scope: 'global' },
      { decision: 'allow', fields: {} },
    ]) {
      await refused(await answer(task, request, await yes(request), body), 'The EA cannot')
    }
    const long = await waiting(`permit echo ${'x'.repeat(700)}`)
    await refused(await answer(long.task, long.request, await yes(long.request)), 'too long for the EA to read back')
    const no = await yes(long.request, { decision: 'deny' })
    expect((await data<PermissionRequest>(await answer(long.task, long.request, no, { decision: 'deny' }))).state).toBe(
      'denied',
    )
  })

  it('takes no notification Allow for it; the user still answers in Seti as before', async () => {
    const { task, request } = await waiting('permit make test')
    const asked = await data<EaAsk>(
      await send('POST', '/ea/asks', EA_AUTH, {
        tool: 'answer_question',
        args: { request: request.id },
        summary: 'allow it',
        key: `tap:${request.id}`,
        epoch: 'e1',
        turn: 1,
      }),
    )
    await refused(
      await send('POST', `/ea/asks/${String(asked.id)}/decision`, USER_AUTH, { decision: 'allow' }),
      'own yes',
    )
    const mine = await send('POST', `/tasks/${task.id}/permission-requests/${request.id}`, USER_AUTH, {
      decision: 'allow',
    })
    expect((await data<PermissionRequest>(mine)).state).toBe('allowed')
  })

  it('gives agents and mods none of it, whatever question they name', async () => {
    const { task, request } = await waiting('permit make lint')
    const ask = await yes(request)
    const agent = asAgent(task, async () => answerPermission(task, request.id, { decision: 'allow' }, ask))
    await expect(agent).rejects.toThrow('Agents cannot answer permission requests')
    const mod = asMod({ id: 'grid', grants: [] }, async () => answerPermission(task, request.id, { decision: 'deny' }))
    await expect(mod).rejects.toThrow('Mods cannot answer permission requests')
    expect(await state(request)).toBe('pending')
  })
})
