import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { MessageRow } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { calmOutcome } from '@/panels/tasks/calm-outcome'

let nextId = 0

const sdkRow = (type: string, payload: Record<string, unknown>): MessageRow => {
  nextId += 1
  const message = { type, session_id: 's', uuid: String(nextId), ...payload }
  return {
    id: nextId,
    task_id: 't',
    outward: [],
    created_at: '2026-10-02T10:00:00.000Z',
    kind: 'sdk',
    payload: message as unknown as SDKMessage,
  }
}

const prompt = (): MessageRow => {
  nextId += 1
  return {
    id: nextId,
    task_id: 't',
    outward: [],
    created_at: '2026-10-02T10:00:00.000Z',
    kind: 'prompt',
    payload: { text: 'Do the work' },
  }
}

const said = (content: unknown, parent: string | null = null) =>
  sdkRow('assistant', { message: { role: 'assistant', content }, parent_tool_use_id: parent })

const answered = (id: string) =>
  sdkRow('user', {
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    parent_tool_use_id: null,
  })

const done = () => sdkRow('result', { subtype: 'success', is_error: false, result: '', duration_ms: 0 })

const text = (value: string) => ({ type: 'text', text: value })
const call = (id: string, name = 'Bash', input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input })

const IDLE = { running: false, blocked: false }
const RUNNING = { running: true, blocked: false }

describe('calmOutcome', () => {
  it('shows the last message of a finished turn, not its narration or earlier turns', () => {
    const rows = [
      prompt(),
      said([text('First turn done.')]),
      done(),
      prompt(),
      said([text('Looking at the tests.'), call('a')]),
      answered('a'),
      said([text('Subagent aside')], 'a'),
      said([text('All 27 tests pass.')]),
      said([text('I opened the PR.')]),
      done(),
    ]
    expect(calmOutcome(rows, IDLE)).toEqual({
      question: null,
      working: null,
      text: 'All 27 tests pass.\n\nI opened the PR.',
      stale: false,
    })
  })

  it('keeps the earlier outcome, marked stale, under what a silent running turn does now', () => {
    const run = call('b', 'Bash', { command: 'pnpm test', description: 'Run the payment tests' })
    const rows = [prompt(), said([text('Capped the backoff.')]), done(), prompt(), said([call('a')]), answered('a')]
    expect(calmOutcome([...rows, said([run])], RUNNING)).toEqual({
      question: null,
      working: 'Bash: Run the payment tests',
      text: 'Capped the backoff.',
      stale: true,
    })
    expect(calmOutcome(rows, RUNNING).working).toBe('Working')
  })

  it('shows what a running turn wrote last as soon as it writes, with no working line', () => {
    const rows = [
      prompt(),
      said([text('Old outcome.')]),
      done(),
      prompt(),
      said([text('Reading the threads.'), call('a')]),
      answered('a'),
      said([text('Running the suite again now.'), call('b')]),
    ]
    expect(calmOutcome(rows, RUNNING)).toEqual({
      question: null,
      working: null,
      text: 'Running the suite again now.',
      stale: false,
    })
  })

  it('hands out the question the agent waits on, with the message before it', () => {
    const ask = call('q', 'AskUserQuestion', { questions: [{ header: 'Fix', question: 'Which fix?' }] })
    const rows = [prompt(), said([text('Two fixes work.')]), said([ask])]
    const waiting = calmOutcome(rows, IDLE)
    expect(waiting.question?.id).toBe('q')
    expect(waiting).toMatchObject({ working: null, text: 'Two fixes work.', stale: false })
    expect(calmOutcome(rows, RUNNING).working).toBeNull()
    expect(calmOutcome([...rows, answered('q')], RUNNING).question).toBeNull()
  })

  it('shows no working line while the agent waits on a permission', () => {
    const rows = [prompt(), said([text('Applying now.'), call('a', 'Bash', { command: 'terraform apply' })])]
    expect(calmOutcome(rows, { running: true, blocked: true })).toEqual({
      question: null,
      working: null,
      text: 'Applying now.',
      stale: false,
    })
    const silent = [prompt(), said([text('Earlier.')]), done(), prompt(), said([call('b')])]
    expect(calmOutcome(silent, { running: true, blocked: true })).toMatchObject({ working: null, stale: true })
  })

  it('has nothing to show for an empty transcript, and survives malformed rows', () => {
    expect(calmOutcome([], IDLE)).toEqual({ question: null, working: null, text: null, stale: false })
    expect(calmOutcome([prompt()], RUNNING)).toEqual({ question: null, working: 'Working', text: null, stale: false })
    const rows = [prompt(), said([text('Done.')]), said(7), said([{ type: 'text', text: 42 }, null])]
    expect(calmOutcome(rows, IDLE).text).toBe('Done.')
  })
})
