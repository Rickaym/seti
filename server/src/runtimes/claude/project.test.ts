import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { projectClaude, TURN_COST_KEY, type MessageBody } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { fakeAssistant, fakeMessage, fakeResult } from '../../fake-sdk.js'
import { backgroundResult, movedResult, plainResult } from '../../shell-fixtures.js'
import { assistant, completedResult, launched, toolResult, toolUse } from '../../subtask-fixtures.js'

const sdkOf = (body: MessageBody): SDKMessage => {
  if (body.kind !== 'sdk') {
    throw new Error('not an sdk row')
  }
  return body.payload
}

const project = (body: MessageBody) => projectClaude(sdkOf(body))
const raw = (message: Record<string, unknown>) => projectClaude(message as unknown as SDKMessage)

describe('Claude assistant messages', () => {
  it('turns each block into an event in order, ids from the message uuid', () => {
    const body = assistant([
      { type: 'thinking', thinking: 'Plan first.', signature: 'sig' },
      { type: 'text', text: 'Running the tests.' },
      toolUse('toolu_1', 'Bash', { command: 'pnpm test' }),
      { type: 'redacted_thinking', data: 'x' },
    ])
    const { uuid } = sdkOf(body) as { uuid: string }
    expect(project(body)).toEqual([
      { v: 1, thread: '', type: 'reasoning', id: `${uuid}:0`, text: 'Plan first.', summary: false },
      { v: 1, thread: '', type: 'message', id: `${uuid}:1`, role: 'agent', text: 'Running the tests.' },
      {
        v: 1,
        thread: '',
        type: 'tool.started',
        call: {
          callId: 'toolu_1',
          kind: 'shell',
          name: 'Bash',
          input: { command: 'pnpm test' },
          shell: { action: 'run', command: 'pnpm test' },
        },
      },
      { v: 1, thread: '', type: 'reasoning', id: `${uuid}:3`, text: '', summary: false },
    ])
  })

  it('puts a subagent message on its thread, the Agent call that started it', () => {
    expect(project(assistant([{ type: 'text', text: 'Looking.' }], 'toolu_agent'))).toMatchObject([
      { thread: 'toolu_agent', type: 'message', role: 'agent', text: 'Looking.' },
    ])
    expect(projectClaude(fakeAssistant('Hello') as unknown as SDKMessage)).toMatchObject([
      { thread: '', type: 'message', text: 'Hello' },
    ])
  })

  it('keeps a block it cannot map as vendor', () => {
    expect(project(assistant([{ type: 'server_tool_use', id: 's1', name: 'web_search' }]))).toMatchObject([
      { type: 'vendor', name: 'assistant/server_tool_use' },
    ])
  })

  it('adds a notice for an error the message reports, telling login errors apart', () => {
    const failed = (error: string) =>
      raw({
        type: 'assistant',
        uuid: 'u1',
        parent_tool_use_id: null,
        error,
        message: { content: [{ type: 'text', text: 'API Error' }] },
      })
    expect(failed('authentication_failed').at(-1)).toEqual({
      v: 1,
      thread: '',
      type: 'notice',
      code: 'auth',
      text: 'authentication_failed',
    })
    expect(failed('billing_error').at(-1)).toMatchObject({ code: 'auth' })
    expect(failed('rate_limit').at(-1)).toMatchObject({ code: 'rate_limited' })
    expect(failed('overloaded')).toMatchObject([
      { type: 'message' },
      { type: 'notice', code: 'info', text: 'overloaded' },
    ])
  })
})

describe('Claude tool results', () => {
  it('ends a call with its text, ok or error', () => {
    expect(project(plainResult('toolu_1', 'done\n'))).toEqual([
      {
        v: 1,
        thread: '',
        type: 'tool.ended',
        callId: 'toolu_1',
        status: 'ok',
        result: {
          text: 'done\n',
          images: 0,
          structured: { stdout: 'done\n', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
        },
      },
    ])
    expect(project(toolResult('toolu_2', 'Exit code 2\nboom', { isError: true }))).toMatchObject([
      { type: 'tool.ended', callId: 'toolu_2', status: 'error', result: { text: 'Exit code 2\nboom', exitCode: 2 } },
    ])
  })

  it('joins text parts by lines and counts images', () => {
    const content = [
      { type: 'text', text: 'one' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'two' },
    ]
    expect(project(toolResult('toolu_3', content, { parent: 'toolu_agent' }))).toMatchObject([
      { thread: 'toolu_agent', type: 'tool.ended', result: { text: 'one\ntwo', images: 1 } },
    ])
    expect(project(toolResult('toolu_4', undefined))).toMatchObject([{ result: { text: '', images: 0 } }])
  })

  it('reads where a background command runs, from the structured output or the text', () => {
    const [event] = project(backgroundResult('toolu_bg', 'b7x2k'))
    expect(event).toMatchObject({
      type: 'tool.ended',
      result: { job: { id: 'b7x2k', output: expect.stringMatching(/\/tasks\/b7x2k\.output$/) as unknown } },
    })
    const text = 'Command running in background with ID: b9. Output is being written to: /work/t/b9.output. Done.'
    expect(project(toolResult('toolu_bg2', text))).toMatchObject([
      { result: { job: { id: 'b9', output: '/work/t/b9.output' } } },
    ])
    expect(project(movedResult('toolu_mv', 'b3'))[0]).not.toHaveProperty('result.job')
  })

  it('reads a launched agent from its output, or from the text of an imported row', () => {
    expect(project(launched('toolu_a', 'a1b2'))).toMatchObject([{ result: { job: { id: 'a1b2' } } }])
    expect(project(launched('toolu_a', 'a3b4', true))).toMatchObject([{ result: { job: { id: 'a3b4' } } }])
    expect(project(toolResult('toolu_r', 'Remote agent launched.'))).toMatchObject([{ result: { job: { id: null } } }])
    expect(project(completedResult('toolu_c', 'a5', 'All good.'))[0]).not.toHaveProperty('result.job')
  })

  it('reads the id of a created plan item', () => {
    expect(project(toolResult('toolu_t', 'Task #7 created successfully: Fix CI'))).toMatchObject([
      { result: { planId: '7' } },
    ])
    expect(project(toolResult('toolu_t', 'Created', { output: { task: { id: '8', subject: 's' } } }))).toMatchObject([
      { result: { planId: '8' } },
    ])
  })

  it('gives every result of a message the message structured output', () => {
    const body = raw({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'a' },
          { type: 'tool_result', tool_use_id: 't2', content: 'b', is_error: true },
        ],
      },
      tool_use_result: { ok: true },
    })
    expect(body).toMatchObject([
      { callId: 't1', status: 'ok', result: { structured: { ok: true } } },
      { callId: 't2', status: 'error', result: { structured: { ok: true } } },
    ])
  })
})

describe('Claude user text', () => {
  const said = (content: unknown, extra: Record<string, unknown> = {}) =>
    raw({ type: 'user', uuid: 'u9', parent_tool_use_id: null, message: { role: 'user', content }, ...extra })

  it('is user text, marked when Claude Code wrote it', () => {
    expect(said('Base directory for this skill: /s')).toEqual([
      { v: 1, thread: '', type: 'message', id: 'u9', role: 'user', text: 'Base directory for this skill: /s' },
    ])
    expect(
      said(
        [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
        { isSynthetic: true },
      ),
    ).toMatchObject([{ role: 'user', text: 'ab', synthetic: true }])
  })

  it("reads a slash command's printed output", () => {
    expect(said('<local-command-stdout>  Set model to haiku </local-command-stdout>')).toMatchObject([
      { type: 'message', role: 'command', text: 'Set model to haiku' },
    ])
  })

  it('reads an interruption as a notice', () => {
    expect(said([{ type: 'text', text: '[Request interrupted by user]' }])).toEqual([
      { v: 1, thread: '', type: 'notice', code: 'interrupted', text: '[Request interrupted by user]' },
    ])
    expect(said('[Request interrupted by user for tool use]')).toMatchObject([{ type: 'notice', code: 'interrupted' }])
  })

  it('puts the results first and the text after', () => {
    const content = [
      { type: 'tool_result', tool_use_id: 't1', content: 'x' },
      { type: 'text', text: 'more' },
    ]
    expect(said(content).map((event) => event.type)).toEqual(['tool.ended', 'message'])
  })
})

describe('Claude results', () => {
  it("ends the turn with the reply and the turn's own cost, not the session total", () => {
    const result = { ...fakeResult(), uuid: 'r1', result: 'All done.', total_cost_usd: 3, [TURN_COST_KEY]: 0.25 }
    expect(raw(result)).toEqual([
      {
        v: 1,
        thread: '',
        type: 'turn.ended',
        turnId: 'r1',
        status: 'ok',
        result: 'All done.',
        cause: 'input',
        steps: 1,
        costUsd: 0.25,
        durationMs: 1,
        answered: [],
      },
    ])
  })

  it('reports an error by its subtype, or by the result text when it says success', () => {
    expect(raw({ ...fakeResult(true), uuid: 'r2' })).toMatchObject([
      { type: 'turn.ended', status: 'error', result: '', error: 'error_during_execution' },
    ])
    const apiError = { ...fakeResult(), is_error: true, result: 'API Error: 401', api_error_status: 401, uuid: 'r3' }
    expect(raw(apiError)).toMatchObject([{ status: 'error', error: 'API Error: 401', apiStatus: 401 }])
  })

  it('reads a background turn, its steps, usage and the messages it answered', () => {
    const result = {
      ...fakeResult(),
      uuid: 'r4',
      num_turns: 0,
      origin: { kind: 'task-notification' },
      user_message_uuids: ['p1', 'p2'],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    }
    expect(raw(result)).toMatchObject([
      {
        cause: 'background',
        steps: 0,
        answered: ['p1', 'p2'],
        usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 },
      },
    ])
    expect(raw({ ...fakeResult(), uuid: 'r5', user_message_uuid: 'p3' })).toMatchObject([{ answered: ['p3'] }])
  })
})

describe('other Claude messages', () => {
  it('reads tool progress on its thread', () => {
    const progress = fakeMessage('tool_progress', {
      tool_use_id: 'toolu_1',
      tool_name: 'Bash',
      parent_tool_use_id: 'toolu_agent',
      elapsed_time_seconds: 2.5,
    })
    expect(projectClaude(progress as unknown as SDKMessage)).toEqual([
      { v: 1, thread: 'toolu_agent', type: 'tool.progress', callId: 'toolu_1', elapsedMs: 2500 },
    ])
  })

  it('reads a rate limit that turned the agent away, and keeps the others as vendor', () => {
    const limit = (status: string) => raw({ type: 'rate_limit_event', rate_limit_info: { status }, uuid: 'x' })
    expect(limit('rejected')).toEqual([{ v: 1, thread: '', type: 'notice', code: 'rate_limited', text: 'rejected' }])
    expect(limit('allowed_warning')).toEqual([{ v: 1, thread: '', type: 'vendor', name: 'rate_limit_event' }])
  })

  it('keeps a message type it does not map as vendor', () => {
    expect(raw({ type: 'stream_event', event: {} })).toEqual([
      { v: 1, thread: '', type: 'vendor', name: 'stream_event' },
    ])
    expect(raw({ type: 'prompt_suggestion', suggestion: 's' })).toMatchObject([
      { type: 'vendor', name: 'prompt_suggestion' },
    ])
  })

  it('turns a message it cannot read into one vendor event instead of throwing', () => {
    expect(raw({ type: 'assistant', message: null })).toEqual([{ v: 1, thread: '', type: 'vendor', name: 'assistant' }])
    expect(raw({ type: 'system', subtype: 'task_progress' })).toEqual([
      { v: 1, thread: '', type: 'vendor', name: 'system/task_progress' },
    ])
    expect(raw({})).toEqual([{ v: 1, thread: '', type: 'vendor', name: 'unknown' }])
  })
})
