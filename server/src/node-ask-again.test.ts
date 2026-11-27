import { randomUUID } from 'node:crypto'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { tasks } from './db.js'
import { nodeLink } from './node-link.js'
import { waitsFor } from './permission-requests.js'
import { answerPermission } from './permission-rules.js'
import { answerQuestions } from './question-answers.js'
import { waiterOf } from './questions.js'
import { stopForRestart } from './restart-state.js'
import { isLateGroup, isLateRequest, keepLeftoverRequests } from './restart-waits.js'
import './runner.js'
import { permissionRequests } from './store/permissions.js'
import { questions } from './store/questions.js'

let count = 0

async function runningTask(): Promise<string> {
  count += 1
  const id = `again-${String(count)}`
  await tasks.insert({ id, title: `Again ${String(count)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  await tasks.setStatus(id, 'running', null)
  return id
}

async function taskOf(id: string) {
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('no task')
  }
  return task
}

const options = { toolUseID: 'toolu_1', requestId: 'req_1' }

/** The node asks once; the control plane that answered stops before the user does. */
async function askedBeforeRestart(taskId: string, ask: string, tool: string, input: Record<string, unknown>) {
  const first = new AbortController()
  const ended = nodeLink
    .answer(
      { type: 'ask', id: ask, agent: taskId, ask: 'permission.ask', body: { tool, input, options } },
      first.signal,
    )
    .catch(() => undefined)
  await expect
    .poll(async () => (await permissionRequests.pending(taskId)).length + (await questions.openList(taskId)).length)
    .toBe(1)
  stopForRestart()
  first.abort()
  await ended
}

const resultOf = (answer: unknown) => (answer as { result: PermissionResult }).result

describe('an ask a node sends again after the control plane restarted', () => {
  it('waits on the request it recorded, so the user sees one and the answer reaches the call once', async () => {
    const id = await runningTask()
    const ask = randomUUID()
    await askedBeforeRestart(id, ask, 'Bash', { command: 'make deploy' })
    await keepLeftoverRequests(new Set([ask]))
    expect(isLateRequest(ask)).toBe(false)

    const again = nodeLink.answer(
      {
        type: 'ask',
        id: ask,
        agent: id,
        ask: 'permission.ask',
        body: { tool: 'Bash', input: { command: 'make deploy' }, options },
      },
      new AbortController().signal,
    )
    await expect.poll(() => waitsFor(ask)).toBe(true)
    expect((await permissionRequests.pending(id)).map((request) => request.id)).toEqual([ask])
    expect(await answerPermission(await taskOf(id), ask, { decision: 'allow' })).toBeTruthy()
    expect(resultOf(await again)).toMatchObject({ behavior: 'allow' })
    expect(await permissionRequests.pending(id)).toEqual([])
  })

  it('waits on the question group it recorded, and an ask no node waits on stays for a late answer', async () => {
    const id = await runningTask()
    const ask = randomUUID()
    const input = {
      questions: [{ question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }] }],
    }
    await askedBeforeRestart(id, ask, 'AskUserQuestion', input)
    const other = await runningTask()
    const lost = randomUUID()
    await askedBeforeRestart(other, lost, 'AskUserQuestion', input)
    await keepLeftoverRequests(new Set([ask]))
    expect(isLateGroup(ask)).toBe(false)
    expect(isLateGroup(lost)).toBe(true)

    const again = nodeLink.answer(
      { type: 'ask', id: ask, agent: id, ask: 'permission.ask', body: { tool: 'AskUserQuestion', input, options } },
      new AbortController().signal,
    )
    await expect.poll(() => waiterOf(ask) !== undefined).toBe(true)
    const [question] = await questions.group(ask)
    expect(await questions.openList(id)).toHaveLength(1)
    await answerQuestions({ items: [{ id: question?.id ?? '', action: 'answer', selected: ['Yes'], other: null }] })
    expect(resultOf(await again)).toMatchObject({ behavior: 'allow' })
  })
})
