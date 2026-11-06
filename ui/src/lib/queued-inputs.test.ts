import type { MessageRow, PrInput, TaskInput, TeamInput } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { clockTime } from '@/components/account/format'
import { dismissQuestion, waitingReason } from '@/lib/queued-inputs'
import { queuedInputs } from '@/lib/transcript'

const PAUSED = '2026-09-01T11:00:00.000Z'

describe('waitingReason', () => {
  it('names the burst pause and when it ends for a wake task', () => {
    expect(waitingReason('wake', false, PAUSED, [review])).toEqual({
      kind: 'paused',
      text: `Seti paused after a burst of automatic turns and hands them over at ${clockTime(PAUSED)}.`,
    })
  })

  it('waits for the turn that is running', () => {
    expect(waitingReason('wake', true, PAUSED, [review]).kind).toBe('turn')
  })

  it('hands them to an idle wake task in a few seconds, subagent PRs included', () => {
    const subtask = { tool_use_id: 'toolu_1', description: 'fix lint', agent_id: null, running: true }
    expect(waitingReason('wake', false, null, [{ ...review, subtask }]).kind).toBe('soon')
    expect(waitingReason('wake', false, null, [mention, review]).kind).toBe('soon')
  })

  it.each([
    ['queue', null],
    ['queue', PAUSED],
    ['off', null],
  ] as const)('leaves %s updates with pause %s for the next message', (mode, paused) => {
    expect(waitingReason(mode, false, paused, [review]).kind).toBe('message')
  })

  it('leaves group chat messages for the next message, as they never wake the agent', () => {
    expect(waitingReason('wake', false, null, [mention]).kind).toBe('message')
    expect(waitingReason('wake', true, PAUSED, [mention]).kind).toBe('message')
  })
})

const review: PrInput = {
  source: 'pr',
  kind: 'review',
  subject: 'acme/web#7',
  title: 'Review',
  body: '',
  url: null,
}
const mention: TeamInput = {
  source: 'team',
  kind: 'mention',
  subject: 'user',
  title: 'Group chat message',
  body: 'look',
  url: null,
  message_id: 1,
}

const inputRow = (id: number, payload: TaskInput): MessageRow => ({
  id,
  task_id: 't',
  outward: [],
  created_at: PAUSED,
  kind: 'input',
  payload,
})

describe('dismissQuestion', () => {
  it('says how many updates of each source it would dismiss', () => {
    expect(dismissQuestion([review, mention, review])).toBe(
      'Dismiss 3 waiting updates (2 PR updates, 1 group chat message)? The agent never gets them; they stay in the transcript, marked dismissed.',
    )
  })
})

describe('queuedInputs', () => {
  it('leaves out dismissed updates and those before the last prompt the agent read', () => {
    const rows: MessageRow[] = [
      inputRow(1, review),
      { id: 2, task_id: 't', outward: [], created_at: PAUSED, kind: 'prompt', payload: { text: 'go' } },
      inputRow(3, { ...review, dismissed_at: PAUSED }),
      inputRow(4, mention),
    ]
    expect(queuedInputs(rows).map((row) => row.id)).toEqual([4])
  })
})
