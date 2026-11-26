import { projectAcp, type AcpRecord, type RuntimeEvent } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import recorded from './recorded-turn.json' with { type: 'json' }

/** The recorded session as the driver would store it: one record per update, then the turn's end. */
function stored(): AcpRecord[] {
  const updates = recorded.messages.flatMap((each, index) =>
    'update' in each ? [{ seti: 'update' as const, id: `u${String(index)}`, update: each.update }] : [],
  )
  const result = recorded.messages.flatMap((each) => ('result' in each ? [each.result] : []))[0]
  return [
    { seti: 'started', sessionId: 's1', model: 'gemini-3.8-flash', cwd: recorded.cwd },
    { seti: 'turn', turnId: 't1' },
    ...updates,
    { seti: 'ended', turnId: 't1', stopReason: 'end_turn', result: 'All done.', usage: result?.usage ?? null },
  ]
}

const events = (records: readonly AcpRecord[]): RuntimeEvent[] => records.flatMap(projectAcp)

const calls = (all: readonly RuntimeEvent[]) =>
  all.flatMap((event) => (event.type === 'tool.started' ? [event.call] : []))

describe("a Gemini CLI turn's records", () => {
  const all = events(stored())

  it('start the session and the turn, and end the turn with its reply and tokens', () => {
    expect(all[0]).toMatchObject({ type: 'session.started', sessionId: 's1', model: 'gemini-3.8-flash', cwd: '/work' })
    expect(all[1]).toMatchObject({ type: 'turn.started', turnId: 't1', cause: 'input' })
    expect(all.at(-1)).toMatchObject({
      type: 'turn.ended',
      status: 'ok',
      result: 'All done.',
      usage: { input: 700, output: 49, cacheRead: 140 },
    })
  })

  it('show the thought without its empty subject, and the agent saying what it does', () => {
    expect(all.find((event) => event.type === 'reasoning')).toMatchObject({ text: 'Let me look first.' })
    expect(all.filter((event) => event.type === 'message').map((event) => event.text)).toEqual([
      'I will check the files.',
      'All done.',
    ])
  })

  it('name each call by its tool and read its kind from what the agent showed', () => {
    expect(calls(all).map((call) => [call.name, call.kind])).toEqual([
      ['read_file', 'read'],
      ['run_shell_command', 'shell'],
      ['write_file', 'edit'],
      ['replace', 'edit'],
      ['run_shell_command', 'shell'],
    ])
    const [read, shell, write, replace] = calls(all)
    expect(read?.read).toEqual({ paths: ['/work/hello.txt'] })
    expect(shell?.shell).toEqual({ action: 'run', command: 'echo hi > /work/marker', description: 'Write a marker' })
    expect(write?.edit?.changes).toEqual([{ path: '/work/notes.md', op: 'create', before: '', after: 'one\ntwo\n' }])
    expect(replace?.edit?.changes).toEqual([
      { path: '/work/notes.md', op: 'update', before: 'one\ntwo\n', after: 'one\nthree\n' },
    ])
  })

  it('end every call it started', () => {
    const ended = all.flatMap((event) => (event.type === 'tool.ended' ? [[event.callId, event.status]] : []))
    expect(ended).toEqual(calls(all).map((call) => [call.callId, 'ok']))
  })
})

describe('an ACP record', () => {
  const update = (value: unknown, denied = false): AcpRecord => ({
    seti: 'update',
    id: 'u1',
    update: value,
    ...(denied ? { denied: true as const } : {}),
  })

  it('ends a call Seti refused as denied, and a failed one as an error with its text', () => {
    const failed = { sessionUpdate: 'tool_call_update', toolCallId: 'x__x_1', status: 'failed' }
    const said = { ...failed, content: [{ type: 'content', content: { type: 'text', text: 'File not found' } }] }
    expect(projectAcp(update(failed, true))).toMatchObject([{ type: 'tool.ended', status: 'denied' }])
    expect(projectAcp(update(said))).toMatchObject([
      { type: 'tool.ended', status: 'error', result: { text: 'File not found', images: 0 } },
    ])
  })

  it('reads an MCP call from the server and tool Gemini CLI names in its meta', () => {
    const [event] = projectAcp(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'do_thing__seti_1',
        status: 'pending',
        kind: 'other',
        _meta: { 'gemini-cli': { mcp: { server_name: 'seti', tool_name: 'do_thing' } } },
      }),
    )
    expect(event).toMatchObject({
      type: 'tool.started',
      call: { kind: 'mcp', mcp: { server: 'seti', tool: 'do_thing' } },
    })
  })

  it('ends a cancelled turn as interrupted, ending first the calls the cancel cut', () => {
    const projected = projectAcp({
      seti: 'ended',
      turnId: 't2',
      stopReason: 'cancelled',
      result: '',
      usage: null,
      unfinished: ['c1'],
    })
    expect(projected).toMatchObject([
      { type: 'tool.ended', callId: 'c1', status: 'cancelled' },
      { type: 'turn.ended', status: 'interrupted' },
    ])
  })

  it('carries an estimated cost and the reason a turn stopped short', () => {
    const [ended] = projectAcp({
      seti: 'ended',
      turnId: 't3',
      stopReason: 'max_turn_requests',
      result: 'partly',
      usage: { inputTokens: 10, outputTokens: 2, thoughtTokens: 1 },
      usd: 0.5,
    })
    expect(ended).toMatchObject({
      type: 'turn.ended',
      ending: 'turn_limit',
      costUsd: 0.5,
      costEstimated: true,
      usage: { input: 10, output: 2, reasoning: 1 },
    })
  })

  it('keeps an update it does not map as vendor, marking a known kind it could not read', () => {
    expect(projectAcp(update({ sessionUpdate: 'usage_update', used: 1, size: 2 }))).toEqual([
      { v: 1, thread: '', type: 'vendor', name: 'usage_update' },
    ])
    expect(projectAcp(update({ sessionUpdate: 'tool_call' }))).toEqual([
      { v: 1, thread: '', type: 'vendor', name: 'tool_call', unreadable: true },
    ])
  })

  it('joins a plan into items and a user message into its text', () => {
    const plan = { sessionUpdate: 'plan', entries: [{ content: 'Read', priority: 'high', status: 'completed' }] }
    expect(projectAcp(update(plan))).toMatchObject([
      { type: 'plan', items: [{ id: '0', text: 'Read', status: 'completed' }] },
    ])
    const said = { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'go on' } }
    expect(projectAcp(update(said))).toMatchObject([{ type: 'message', role: 'user', text: 'go on' }])
  })
})
