import type { RuntimeEvent, ToolCall } from '@seti/shared'
import { describe, expect, it } from 'vitest'

/**
 * Codex app-server notifications, from one recorded reference turn with paths shortened, mapped
 * by a projector that exists only here. It checks that the neutral events fit a second runtime.
 */
type Json = Record<string, unknown>
type Event = RuntimeEvent

const TURN = '01a20244-c964-7f12-867b-8f7618af6ed6'
const CWD = '/work/project'
const DIFF = '@@ -2,2 +2,2 @@\n \n-Old line.\n+New line written by the scripted model.\n'

const shell = (status: string, extra: Json = {}): Json => ({
  type: 'commandExecution',
  id: 'call_0004',
  command: "/usr/bin/zsh -lc 'echo spike-shell-ran > shell-proof.txt; ls'",
  cwd: CWD,
  status,
  commandActions: [{ type: 'unknown', command: 'echo spike-shell-ran > shell-proof.txt; ls' }],
  aggregatedOutput: null,
  exitCode: null,
  ...extra,
})

const edit = (status: string): Json => ({
  type: 'fileChange',
  id: 'call_0008',
  changes: [{ path: `${CWD}/README.md`, kind: { type: 'update', move_path: null }, diff: DIFF }],
  status,
})

const reply: Json = { type: 'agentMessage', id: 'msg_0010', text: 'Done: ran one command and edited README.md.' }
const usage = {
  totalTokens: 1240,
  inputTokens: 1200,
  cachedInputTokens: 1000,
  outputTokens: 40,
  reasoningOutputTokens: 12,
}

const REFERENCE_TURN: Json[] = [
  { method: 'thread/status/changed', params: { status: { type: 'active', activeFlags: [] } } },
  { method: 'turn/started', params: { turn: { id: TURN, status: 'inProgress', items: [] } } },
  {
    method: 'item/completed',
    params: { item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Reference turn.' }] } },
  },
  {
    method: 'item/completed',
    params: { item: { type: 'reasoning', id: 'rs_0002', summary: ['I will look around first.'], content: [] } },
  },
  { method: 'item/started', params: { item: shell('inProgress') } },
  { method: 'serverRequest/resolved', params: { requestId: 0 } },
  {
    method: 'item/completed',
    params: { item: shell('completed', { aggregatedOutput: 'README.md\nshell-proof.txt\n', exitCode: 0 }) },
  },
  {
    method: 'thread/tokenUsage/updated',
    params: { tokenUsage: { total: usage, last: usage, modelContextWindow: 258_400 } },
  },
  { method: 'item/started', params: { item: edit('inProgress') } },
  { method: 'item/completed', params: { item: edit('completed') } },
  { method: 'turn/diff/updated', params: { diff: `diff --git a/README.md b/README.md\n${DIFF}` } },
  { method: 'item/completed', params: { item: reply } },
  { method: 'turn/completed', params: { turn: { id: TURN, status: 'completed', items: [reply], durationMs: 209 } } },
]

const at = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Json)[key] : undefined
const text = (value: unknown, key: string) => {
  const found = at(value, key)
  return typeof found === 'string' ? found : ''
}
/** The first text of `texts` that is not empty, else empty. */
const firstOf = (...texts: string[]) => texts.find((one) => one !== '') ?? ''
const list = (value: unknown, key: string) => {
  const found = at(value, key)
  return Array.isArray(found) ? (found as unknown[]) : []
}

const base = { v: 1, thread: '' } as const
const ENDED = new Map<string, 'ok' | 'error' | 'denied'>([
  ['completed', 'ok'],
  ['failed', 'error'],
  ['declined', 'denied'],
])
const OPS = new Map<string, 'create' | 'update' | 'delete'>([
  ['add', 'create'],
  ['update', 'update'],
  ['delete', 'delete'],
])

function callOf(item: unknown): ToolCall | null {
  const callId = text(item, 'id')
  switch (text(item, 'type')) {
    case 'commandExecution': {
      const command = firstOf(text(list(item, 'commandActions')[0], 'command'), text(item, 'command'))
      return { callId, kind: 'shell', name: 'commandExecution', input: item, shell: { action: 'run', command } }
    }
    case 'fileChange': {
      const changes = list(item, 'changes').map((change) => ({
        path: text(change, 'path'),
        op: OPS.get(text(at(change, 'kind'), 'type')) ?? 'update',
        diff: text(change, 'diff'),
      }))
      return { callId, kind: 'edit', name: 'fileChange', input: item, edit: { changes } }
    }
    case 'mcpToolCall':
      return {
        callId,
        kind: 'mcp',
        name: text(item, 'tool'),
        input: at(item, 'arguments'),
        mcp: { server: text(item, 'server'), tool: text(item, 'tool') },
      }
    default:
      return null
  }
}

function resultOf(item: unknown): Event {
  const code = at(item, 'exitCode')
  const output = firstOf(
    text(item, 'aggregatedOutput'),
    list(at(item, 'result'), 'content')
      .map((part) => text(part, 'text'))
      .join('\n'),
  )
  return {
    ...base,
    type: 'tool.ended',
    callId: text(item, 'id'),
    status: ENDED.get(text(item, 'status')) ?? 'error',
    result: { text: output, images: 0, ...(typeof code === 'number' ? { exitCode: code } : {}) },
  }
}

function completed(item: unknown): Event | null {
  switch (text(item, 'type')) {
    case 'userMessage':
      return {
        ...base,
        type: 'message',
        id: text(item, 'id'),
        role: 'user',
        text: list(item, 'content')
          .map((part) => text(part, 'text'))
          .join(''),
      }
    case 'agentMessage':
      return { ...base, type: 'message', id: text(item, 'id'), role: 'agent', text: text(item, 'text') }
    case 'reasoning':
      return { ...base, type: 'reasoning', id: text(item, 'id'), text: list(item, 'summary').join('\n'), summary: true }
    default:
      return callOf(item) === null ? null : resultOf(item)
  }
}

const TURN_STATUS = new Map<string, 'ok' | 'error' | 'interrupted'>([
  ['completed', 'ok'],
  ['failed', 'error'],
  ['interrupted', 'interrupted'],
])

function turnEnded(turn: unknown): Event {
  const last = list(turn, 'items')
    .filter((item) => text(item, 'type') === 'agentMessage')
    .at(-1)
  const duration = at(turn, 'durationMs')
  return {
    ...base,
    type: 'turn.ended',
    turnId: text(turn, 'id'),
    status: TURN_STATUS.get(text(turn, 'status')) ?? 'error',
    result: text(last, 'text'),
    cause: 'input',
    ...(typeof duration === 'number' ? { durationMs: duration } : {}),
    answered: [],
  }
}

function tokenUsage(params: unknown): Event {
  const last = at(at(params, 'tokenUsage'), 'last')
  const count = (key: string) => Number(at(last, key) ?? 0)
  return {
    ...base,
    type: 'usage',
    usage: {
      input: count('inputTokens'),
      output: count('outputTokens'),
      cacheRead: count('cachedInputTokens'),
      reasoning: count('reasoningOutputTokens'),
    },
    contextWindow: Number(at(at(params, 'tokenUsage'), 'modelContextWindow')),
  }
}

function projectCodex(message: Json): Event {
  const params = at(message, 'params')
  const method = text(message, 'method')
  const item = at(params, 'item')
  const mapped: Partial<Record<string, () => Event | null>> = {
    'turn/started': () => ({ ...base, type: 'turn.started', turnId: text(at(params, 'turn'), 'id'), cause: 'input' }),
    'turn/completed': () => turnEnded(at(params, 'turn')),
    'item/started': () => {
      const call = callOf(item)
      return call === null ? null : { ...base, type: 'tool.started', call }
    },
    'item/completed': () => completed(item),
    'thread/tokenUsage/updated': () => tokenUsage(params),
    error: () => ({ ...base, type: 'notice', code: 'api_retry', text: text(at(params, 'error'), 'message') }),
  }
  return mapped[method]?.() ?? { ...base, type: 'vendor', name: method }
}

describe('a Codex turn in neutral events', () => {
  const events = REFERENCE_TURN.map(projectCodex)

  it('gives the same sequence a Claude turn gives, with the rest as vendor', () => {
    expect(events.map((event) => event.type)).toEqual([
      'vendor',
      'turn.started',
      'message',
      'reasoning',
      'tool.started',
      'vendor',
      'tool.ended',
      'usage',
      'tool.started',
      'tool.ended',
      'vendor',
      'message',
      'turn.ended',
    ])
  })

  it('reads the shell command, its exit code, the edit as a diff and the reply', () => {
    expect(events[4]).toMatchObject({
      call: { kind: 'shell', shell: { command: 'echo spike-shell-ran > shell-proof.txt; ls' } },
    })
    expect(events[6]).toMatchObject({
      callId: 'call_0004',
      status: 'ok',
      result: { text: 'README.md\nshell-proof.txt\n', exitCode: 0 },
    })
    expect(events[8]).toMatchObject({
      call: { kind: 'edit', edit: { changes: [{ path: `${CWD}/README.md`, op: 'update', diff: DIFF }] } },
    })
    expect(events[7]).toMatchObject({
      usage: { input: 1200, output: 40, cacheRead: 1000, reasoning: 12 },
      contextWindow: 258_400,
    })
    expect(events.at(-1)).toMatchObject({
      type: 'turn.ended',
      turnId: TURN,
      status: 'ok',
      result: reply.text,
      durationMs: 209,
    })
  })

  it('reads a declined command as denied, an MCP call by server and tool, and an interrupted turn', () => {
    expect(projectCodex({ method: 'item/completed', params: { item: shell('declined') } })).toMatchObject({
      status: 'denied',
    })
    const mcp = {
      type: 'mcpToolCall',
      id: 'call_0017',
      server: 'spike',
      tool: 'echo',
      status: 'completed',
      arguments: { text: 'hi' },
      result: { content: [{ type: 'text', text: 'echo: hi' }] },
    }
    expect(projectCodex({ method: 'item/started', params: { item: mcp } })).toMatchObject({
      call: { kind: 'mcp', mcp: { server: 'spike', tool: 'echo' } },
    })
    expect(projectCodex({ method: 'item/completed', params: { item: mcp } })).toMatchObject({
      result: { text: 'echo: hi' },
    })
    const interrupted = { turn: { id: 't2', status: 'interrupted', items: [], durationMs: 2050 } }
    expect(projectCodex({ method: 'turn/completed', params: interrupted })).toMatchObject({
      status: 'interrupted',
      result: '',
    })
    const retry = { error: { message: 'Reconnecting... waiting for network' }, willRetry: true }
    expect(projectCodex({ method: 'error', params: retry })).toMatchObject({ type: 'notice', code: 'api_retry' })
  })
})
