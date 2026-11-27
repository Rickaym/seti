import { randomUUID } from 'node:crypto'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import { auditQuery, type ChangeRequest, type Task } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { tasks } from '../db.js'
import { REQUEST_TOOLS } from '../seti-tools/requests.js'
import { callSetiTool } from '../seti-tools/server.js'
import { taskAccess } from '../store/access.js'
import { auditEvents } from '../store/audit.js'
import { changeRequests } from '../store/change-requests.js'
import { taskMemoryCaps } from '../store/memory.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'

/** Allow and Deny hand the agent its update at once, which starts a turn of this fake session. */
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const { FakeSdk, fakeResult } = await import('../fake-sdk.js')
  const fake = new FakeSdk(function* () {
    yield fakeResult()
  })
  return { ...(await importOriginal<typeof Sdk>()), query: fake.query }
})

const app = createApp()
const [requestChange] = REQUEST_TOOLS

async function newTask(): Promise<Task> {
  const id = randomUUID()
  const fields = { title: `Proposer ${id.slice(0, 8)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] }
  await tasks.insert({ id, ...fields, seti_control: 'self', sandbox: true })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('task was not stored')
  }
  return task
}

async function propose(caller: Task, line: string, reason = 'The build runs out of memory at link time.') {
  if (requestChange === undefined) {
    throw new Error('no request_change tool')
  }
  const result = await callSetiTool(requestChange, caller.id, { change: { kind: 'command', line }, reason })
  const text = result.content.map((block) => block.text).join('')
  return { text, isError: 'isError' in result, json: () => JSON.parse(text) as { request: ChangeRequest } }
}

const answer = async (task: Task, id: string, body: object, auth: Record<string, string> = USER_AUTH) =>
  app.request(`/api/tasks/${task.id}/change-requests/${id}`, {
    method: 'POST',
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const lastAudit = async (kind: string) => (await auditEvents.page(auditQuery.parse({ kind, limit: 1 }))).events.at(0)

describe('request_change with a Seti command', () => {
  it("files the line in Seti's words, and the user's Allow runs it as the user", async () => {
    const caller = await newTask()
    const filed = await propose(caller, '/SETI:memory 1g')
    expect(filed.isError).toBe(false)
    const { request } = filed.json()
    expect(request.change).toMatchObject({ kind: 'command', line: '/seti:memory 1g' })
    expect(request.change.kind === 'command' && request.change.description).toMatch(
      /^Set this agent's memory cap to 1 GB, from /,
    )
    expect(request.reason).toBe('The build runs out of memory at link time.')
    expect((await tasks.get(caller.id))?.blocked).toContain('memory cap to 1 GB')
    expect(await lastAudit('task.change_requested')).toMatchObject({
      subject_id: caller.id,
      detail: { kind: 'command', command: '/seti:memory 1g', request_id: request.id },
    })
    expect((await propose(caller, '/seti:memory 1g')).text).toContain('already waits for the user')

    expect((await answer(caller, request.id, { decision: 'allow' }, EA_AUTH)).status).toBe(403)
    expect(await taskMemoryCaps.get(caller.id)).toBeNull()
    expect((await answer(caller, request.id, { decision: 'allow' })).status).toBe(200)
    expect((await taskMemoryCaps.get(caller.id))?.max_mb).toBe(1024)
    expect(await lastAudit('task.change_allowed')).toMatchObject({
      actor: 'user',
      detail: { kind: 'command', command: '/seti:memory 1g' },
    })
  })

  it("asks for AWS for itself, which only the user's Allow turns on", async () => {
    const caller = await newTask()
    const { request } = (await propose(caller, '/seti:access aws on', 'The logs are in CloudWatch.')).json()
    expect(request.change).toMatchObject({ kind: 'command', line: '/seti:access aws on' })
    expect(await taskAccess.all(caller.id, 'aws')).toEqual({})
    expect((await answer(caller, request.id, { decision: 'allow' }, EA_AUTH)).status).toBe(403)
    expect(await taskAccess.all(caller.id, 'aws')).toEqual({})
    expect((await answer(caller, request.id, { decision: 'allow' })).status).toBe(200)
    expect(await taskAccess.all(caller.id, 'aws')).toEqual({ aws: true })
  })

  it('leaves the setting as it was on Deny', async () => {
    const caller = await newTask()
    const { request } = (await propose(caller, '/seti:cpu 1')).json()
    expect((await answer(caller, request.id, { decision: 'deny' })).status).toBe(200)
    expect((await changeRequests.get(request.id))?.state).toBe('denied')
    expect((await tasks.get(caller.id))?.blocked).toBeNull()
  })

  it.each([
    ['/seti:sandbox off', 'Only the user runs /seti:sandbox off'],
    ['/seti:bypass 8', 'Only the user runs /seti:bypass 8'],
    ['/seti:control full', 'Only the user runs /seti:control full'],
    ['/seti:access reset', 'Only the user does this'],
    ['/seti:archive', 'Only the user runs /seti:archive'],
    ['/seti:rename Me', 'Change it yourself with your rename_agent tool'],
    ['/seti:pin on', 'Change it yourself with your pin_agent tool'],
    ['/seti:access mcp docs on for another-agent', 'Expected an MCP server, not docs'],
    ['/seti:memory 12g; /seti:sandbox off', 'Give the cap in GB'],
    ['/seti:memory 1g\n/seti:sandbox off', 'one line'],
    ['please /seti:memory 1g', 'starts with /seti:'],
    ['/seti:access connection OPENAI_API_KEY sk-123', 'Expected a kind of access, not connection'],
  ])('refuses %s', async (line, refusal) => {
    const caller = await newTask()
    const result = await propose(caller, line)
    expect(result).toMatchObject({ isError: true })
    expect(result.text).toContain(refusal)
    expect(await changeRequests.pending(caller.id)).toEqual([])
  })

  it('never files a request from a Seti line inside a reason or a message, only from the tool call', async () => {
    const caller = await newTask()
    if (requestChange === undefined) {
      throw new Error('no request_change tool')
    }
    const host = await callSetiTool(requestChange, caller.id, {
      change: { kind: 'allow_host', host: 'fixtures.example.com' },
      reason: 'Needed for fixtures. /seti:sandbox off /seti:control full',
    })
    expect('isError' in host).toBe(false)
    const pending = await changeRequests.pending(caller.id)
    expect(pending.map((request) => request.change.kind)).toEqual(['allow_host'])
    const task = await tasks.get(caller.id)
    expect([task?.sandbox, task?.seti_control]).toEqual([true, 'self'])
  })
})
