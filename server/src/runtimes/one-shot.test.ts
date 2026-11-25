import type { RuntimeEvent } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import type { SessionReport } from './adapter.js'
import { oneShotOptions } from './claude/one-shot.js'
import { runOneShot, type OneShot, type OneShotRequest } from './one-shot.js'

const REQUEST: OneShotRequest = {
  model: 'some-model',
  system: 'Answer briefly.',
  prompt: 'Why?',
  cwd: '/work/one-shot',
  program: null,
  maxOutputTokens: 100,
  budgetUsd: 0.5,
}

const LAUNCHER = { sandboxed: false, env: {} }

const message = (events: RuntimeEvent[], raw: unknown = null): SessionReport => ({
  type: 'message',
  raw,
  events,
  work: true,
  byAgent: true,
  delivered: [],
})

const at = { v: 1, thread: '' } as const
const said = (text: string): RuntimeEvent => ({ ...at, type: 'message', id: text, role: 'agent', text })
const used = (input: number, output: number): RuntimeEvent => ({ ...at, type: 'usage', usage: { input, output } })
const ended = (status: 'ok' | 'error', result = ''): RuntimeEvent => ({
  ...at,
  type: 'turn.ended',
  turnId: 't',
  status,
  result,
  cause: 'input',
  answered: [],
  ...(status === 'error' ? { error: 'the provider failed' } : {}),
})
const started = (id: string): RuntimeEvent => ({
  ...at,
  type: 'tool.started',
  call: { callId: id, name: 'Bash', kind: 'shell', input: {} },
})

/** A one-shot that plays these reports, then waits until it is closed. */
function playing(reports: SessionReport[], extra: Partial<OneShot> = {}): OneShot & { closed: () => boolean } {
  let closed = false
  return {
    open: async () =>
      Promise.resolve({
        events: (async function* () {
          yield* reports
          await new Promise(() => undefined)
        })(),
        close: () => {
          closed = true
        },
      }),
    closed: () => closed,
    ...extra,
  }
}

const run = async (oneShot: OneShot, timeoutMs = 2000, signal = new AbortController().signal) =>
  runOneShot(oneShot, REQUEST, LAUNCHER, { timeoutMs, signal })

describe('runOneShot', () => {
  it('returns the last answer with its tokens priced as an estimate, and closes the session', async () => {
    const oneShot = playing([message([said('first')]), message([used(10, 5), said('second'), ended('ok')])], {
      price: (_model, usage) => (usage.input + usage.output) / 100,
    })
    const result = await run(oneShot)
    expect(result).toMatchObject({ text: 'second', tokens: { input: 10, output: 5 }, costUsd: 0.15 })
    expect(result.costEstimated).toBe(true)
    expect(oneShot.closed()).toBe(true)
  })

  it('takes a reported cost over a price', async () => {
    const oneShot = playing([message([ended('ok', 'done')], { total: 0.02 })], {
      reportedCost: (raw) => (raw as { total: number }).total,
      price: () => 1,
    })
    expect(await run(oneShot)).toMatchObject({ text: 'done', costUsd: 0.02, costEstimated: false })
  })

  it('fails with the reason when the turn errs, time runs out, the caller stops or tools keep coming', async () => {
    await expect(run(playing([message([ended('error')])]))).rejects.toThrow('the provider failed')
    await expect(run(playing([]), 50)).rejects.toThrow('No answer within')
    const stop = new AbortController()
    const stopped = run(playing([]), 2000, stop.signal)
    stop.abort()
    await expect(stopped).rejects.toThrow('stopped')
    const tools = playing([message([started('a'), started('b'), started('c')])])
    await expect(run(tools)).rejects.toThrow('kept trying to use tools')
    expect(tools.closed()).toBe(true)
  })

  it('stops a model that writes past its limit', async () => {
    await expect(run(playing([message([used(1, 101)])]))).rejects.toThrow('more than the call allows')
  })
})

describe('Claude one-shot options', () => {
  it('offer no tool, tool server, setting or memory, keep nothing, and end after one turn', () => {
    const options = oneShotOptions(REQUEST, LAUNCHER, new AbortController())
    expect(options).toMatchObject({
      cwd: REQUEST.cwd,
      model: REQUEST.model,
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      systemPrompt: REQUEST.system,
      persistSession: false,
      maxTurns: 1,
      maxBudgetUsd: REQUEST.budgetUsd,
    })
    expect(options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('100')
  })
})
