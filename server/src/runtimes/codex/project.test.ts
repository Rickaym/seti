import { projectCodex, type CodexMessage, type RuntimeEvent } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import recorded from './reference-turn.json' with { type: 'json' }

const ROOT = '01a20244-c954-7390-bda1-b0194900d368'
const CHILD = '01a20244-ffff-7000-8000-000000000001'

const stored = (method: string, params: unknown, root = ROOT): CodexMessage => ({ root, message: { method, params } })
const one = (method: string, params: unknown): RuntimeEvent => {
  const [event] = projectCodex(stored(method, params))
  if (event === undefined) {
    throw new Error('no event')
  }
  return event
}

const item = (value: Record<string, unknown>, threadId = ROOT) => ({ item: value, threadId, turnId: 't1' })

const shell = (status: string, extra: Record<string, unknown> = {}) => ({
  type: 'commandExecution',
  id: 'call_1',
  command: "/usr/bin/zsh -lc 'echo it'\\''s > out.txt'",
  cwd: '/work/project',
  status,
  commandActions: [{ type: 'unknown', command: "echo it's > out.txt" }],
  aggregatedOutput: null,
  exitCode: null,
  ...extra,
})

describe('a recorded Codex turn in neutral events', () => {
  const events = recorded.flatMap((message) => projectCodex({ root: ROOT, message }))

  it('maps the turn, its calls and its reply, and keeps the rest as vendor', () => {
    expect(events.filter((event) => event.type !== 'vendor').map((event) => event.type)).toEqual([
      'session.started',
      'turn.started',
      'message',
      'reasoning',
      'tool.started',
      'tool.ended',
      'usage',
      'reasoning',
      'tool.started',
      'tool.ended',
      'usage',
      'message',
      'usage',
      'turn.ended',
    ])
    expect(events).toHaveLength(recorded.length)
    expect(events.every((event) => event.thread === '')).toBe(true)
    expect(events.some((event) => event.type === 'vendor' && event.unreadable === true)).toBe(false)
  })

  it('reads the session, the shell command, the edit, the usage and the reply', () => {
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'session.started', sessionId: ROOT, model: 'gpt-5.5', cwd: '/work/project' }),
    )
    expect(events).toContainEqual({
      v: 1,
      thread: '',
      type: 'tool.started',
      call: {
        callId: 'call_0004',
        kind: 'shell',
        name: 'exec_command',
        input: { command: 'echo spike-shell-ran > shell-proof.txt; ls', cwd: '/work/project' },
        shell: { action: 'run', command: 'echo spike-shell-ran > shell-proof.txt; ls' },
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.ended',
        callId: 'call_0004',
        status: 'ok',
        result: { text: 'README.md\nshell-proof.txt\n', images: 0, exitCode: 0 },
      }),
    )
    const edit = events.find((event) => event.type === 'tool.started' && event.call.kind === 'edit')
    expect(edit).toMatchObject({ call: { edit: { changes: [{ path: '/work/project/README.md', op: 'update' }] } } })
    expect(events.at(-1)).toMatchObject({
      type: 'turn.ended',
      status: 'ok',
      result: 'Done: ran one command and edited README.md.',
      durationMs: 197,
    })
  })

  it('gives the same events for a message read back from storage', () => {
    const again = recorded.flatMap((message) => projectCodex(JSON.parse(JSON.stringify({ root: ROOT, message }))))
    expect(again).toEqual(events)
  })
})

describe('Codex calls', () => {
  it('unwraps the shell, quotes included, and reads a declined command as denied', () => {
    expect(one('item/started', item(shell('inProgress')))).toMatchObject({
      call: { shell: { command: "echo it's > out.txt" } },
    })
    expect(one('item/completed', item(shell('declined')))).toMatchObject({ type: 'tool.ended', status: 'denied' })
    const bare = { ...shell('inProgress'), command: '/usr/bin/zsh -lc ls' }
    expect(one('item/started', item(bare))).toMatchObject({ call: { shell: { command: 'ls' } } })
    expect(one('item/completed', item(shell('failed', { exitCode: 2 })))).toMatchObject({
      status: 'error',
      result: { exitCode: 2 },
    })
  })

  it('names an MCP call by server and tool, with its text or its error', () => {
    const mcp = { type: 'mcpToolCall', id: 'call_2', server: 'spike', tool: 'echo', arguments: { text: 'hi' } }
    expect(one('item/started', item({ ...mcp, status: 'inProgress' }))).toMatchObject({
      call: { kind: 'mcp', name: 'mcp__spike__echo', input: { text: 'hi' }, mcp: { server: 'spike', tool: 'echo' } },
    })
    const done = { ...mcp, status: 'completed', result: { content: [{ type: 'text', text: 'echo: hi' }] } }
    expect(one('item/completed', item(done))).toMatchObject({ status: 'ok', result: { text: 'echo: hi' } })
    const failed = { ...mcp, status: 'failed', error: { message: 'user rejected MCP tool call' } }
    expect(one('item/completed', item(failed))).toMatchObject({
      status: 'error',
      result: { text: 'user rejected MCP tool call' },
    })
  })

  it('reads moves, additions and deletions of files', () => {
    const changes = [
      { path: '/w/a', kind: { type: 'add' }, diff: '+a' },
      { path: '/w/b', kind: { type: 'delete' }, diff: '-b' },
      { path: '/w/c', kind: { type: 'update', move_path: '/w/d' }, diff: '' },
    ]
    expect(one('item/started', item({ type: 'fileChange', id: 'p', changes, status: 'inProgress' }))).toMatchObject({
      call: {
        edit: {
          changes: [
            { path: '/w/a', op: 'create' },
            { path: '/w/b', op: 'delete' },
            { path: '/w/c', op: 'move', to: '/w/d' },
          ],
        },
      },
    })
  })

  it("starts the session from a resumed thread's reply, which Codex sends in place of thread/started", () => {
    const thread = { id: ROOT, model: 'gpt-5.5', environments: [{ cwd: '/work/project' }] }
    const row: CodexMessage = {
      root: ROOT,
      message: { method: 'thread/resume', params: { threadId: ROOT } },
      reply: { thread, model: 'gpt-5.5' },
    }
    expect(projectCodex(row)).toMatchObject([{ type: 'session.started', sessionId: ROOT, cwd: '/work/project' }])
  })

  it("keeps remote control's status, which names the host, as a vendor event with no detail", () => {
    const params = { status: 'disabled', serverName: 'a-host', installationId: 'i-1', environmentId: null }
    expect(projectCodex(stored('remoteControl/status/changed', params))).toEqual([
      { v: 1, thread: '', type: 'vendor', name: 'remoteControl/status/changed' },
    ])
  })

  it('opens a thread for a spawned subagent, and its own messages carry that thread', () => {
    const spawn = {
      type: 'collabAgentToolCall',
      id: 'call_3',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: ROOT,
      receiverThreadIds: [CHILD],
      prompt: 'Check the tests\nThen report',
    }
    expect(one('item/started', item(spawn))).toMatchObject({
      thread: '',
      call: { kind: 'subagent', subagent: { label: 'Check the tests', thread: CHILD } },
    })
    const reply = { type: 'agentMessage', id: 'm', text: 'tests pass' }
    expect(one('item/completed', item(reply, CHILD))).toMatchObject({ thread: CHILD, role: 'agent' })
    expect(projectCodex(stored('thread/started', { thread: { id: CHILD, parentThreadId: ROOT } }))).toEqual([
      { v: 1, thread: CHILD, type: 'vendor', name: 'thread/started' },
    ])
  })

  it('asks the user a structured question', () => {
    const params = {
      threadId: ROOT,
      turnId: 't1',
      itemId: 'q1',
      questions: [{ id: 'a', header: 'Pick', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }],
    }
    expect(one('item/tool/requestUserInput', params)).toMatchObject({
      type: 'tool.started',
      call: { callId: 'q1', kind: 'question', question: { questions: [{ text: 'Which one?', options: ['A', 'B'] }] } },
    })
    const answered = (reply: unknown) => projectCodex({ ...stored('item/tool/requestUserInput', params), reply })
    expect(answered({ answers: { a: { answers: ['B'] } } })).toEqual([
      { v: 1, thread: '', type: 'tool.ended', callId: 'q1', status: 'ok', result: { text: 'Which one? B', images: 0 } },
    ])
    expect(answered({ answers: {} })).toMatchObject([{ type: 'tool.ended', status: 'cancelled' }])
  })
})

describe('Codex background commands', () => {
  it('starts a job for each command Codex lists as still running, and ends it with its item', () => {
    const terminal = { itemId: 'call_1', processId: '4242', command: "/usr/bin/zsh -lc 'npm run dev'" }
    const listed = { ...stored('thread/backgroundTerminals/list', { threadId: ROOT }), reply: { data: [terminal] } }
    expect(projectCodex(listed)).toEqual([
      {
        v: 1,
        thread: '',
        type: 'job.started',
        jobId: '4242',
        callId: 'call_1',
        kind: 'shell',
        label: 'npm run dev',
        background: true,
      },
    ])
    const done = item(shell('completed', { aggregatedOutput: 'ready', exitCode: 0, processId: '4242' }))
    const ended = projectCodex({ ...stored('item/completed', done), job: { id: '4242' } })
    expect(ended.map((event) => event.type)).toEqual(['tool.ended', 'job.ended'])
    expect(ended[1]).toMatchObject({ jobId: '4242', callId: 'call_1', status: 'completed', output: 'ready' })
    const stopped = projectCodex({ ...stored('item/completed', done), job: { id: '4242', stopped: true } })
    expect(stopped[1]).toMatchObject({ status: 'stopped' })
  })
})

describe('Codex turns, usage, plans and notices', () => {
  it('ends an interrupted turn as interrupted and a failed one with its error', () => {
    const turn = { id: 't2', status: 'interrupted', items: [], durationMs: 2050 }
    expect(one('turn/completed', { threadId: ROOT, turn })).toMatchObject({ status: 'interrupted', result: '' })
    const failed = { ...turn, status: 'failed', error: { message: 'stream disconnected' } }
    expect(one('turn/completed', { threadId: ROOT, turn: failed })).toMatchObject({
      status: 'error',
      error: 'stream disconnected',
    })
  })

  it('counts input without the cached part, as other runtimes do', () => {
    const last = {
      totalTokens: 1240,
      inputTokens: 1200,
      cachedInputTokens: 1000,
      cacheWriteInputTokens: 0,
      outputTokens: 40,
      reasoningOutputTokens: 12,
    }
    expect(
      one('thread/tokenUsage/updated', { tokenUsage: { last, total: last, modelContextWindow: 258_400 } }),
    ).toEqual({
      v: 1,
      thread: '',
      type: 'usage',
      usage: { input: 200, output: 40, cacheRead: 1000, cacheWrite: 0, reasoning: 12 },
      contextWindow: 258_400,
    })
  })

  it('reports the plan with every step', () => {
    const plan = [
      { step: 'Read', status: 'completed' },
      { step: 'Fix', status: 'inProgress' },
      { step: 'Test', status: 'pending' },
    ]
    expect(one('turn/plan/updated', { threadId: ROOT, turnId: 't', explanation: null, plan })).toMatchObject({
      type: 'plan',
      items: [
        { id: '1', text: 'Read', status: 'completed' },
        { id: '2', text: 'Fix', status: 'in_progress' },
        { id: '3', text: 'Test', status: 'pending' },
      ],
    })
  })

  it('says why the provider refused: a key, a limit, or a retry', () => {
    const error = (codexErrorInfo: unknown, willRetry = false) => ({
      error: { message: 'm', codexErrorInfo },
      willRetry,
    })
    expect(one('error', error('unauthorized'))).toMatchObject({ code: 'auth' })
    expect(one('error', error({ responseStreamConnectionFailed: { httpStatusCode: 401 } }))).toMatchObject({
      code: 'auth',
    })
    expect(one('error', error('usageLimitExceeded'))).toMatchObject({ code: 'rate_limited' })
    expect(one('error', error('serverOverloaded', true))).toMatchObject({ code: 'api_retry' })
  })

  it('keeps unknown methods as quiet vendor events and broken known ones as unreadable', () => {
    expect(projectCodex(stored('account/rateLimits/updated', {}))).toEqual([
      { v: 1, thread: '', type: 'vendor', name: 'account/rateLimits/updated' },
    ])
    expect(projectCodex(stored('turn/completed', { turn: { id: 7 } }))).toEqual([
      { v: 1, thread: '', type: 'vendor', name: 'turn/completed', unreadable: true },
    ])
    expect(projectCodex({ message: 'not stored by Seti' })).toEqual([
      { v: 1, thread: '', type: 'vendor', name: 'codex', unreadable: true },
    ])
  })
})
