import type { ChannelInput, DeliveryTiming, MessageRow, PrInput, TaskInput, TeamInput } from '@seti/shared'
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

  it('follows what each channel subscription chose', () => {
    expect(waitingReason('wake', false, null, [event('with_message')]).kind).toBe('message')
    expect(waitingReason('wake', true, null, [event('with_message'), review]).kind).toBe('turn')
    expect(waitingReason('wake', true, null, [event('now'), review]).text).toBe(
      'The agent gets them at the next step of this turn.',
    )
    expect(waitingReason('wake', true, null, [event('after_turn')]).text).toBe(
      'The agent gets them when this turn ends.',
    )
    expect(waitingReason('wake', false, null, [event('now')]).kind).toBe('soon')
    expect(waitingReason('queue', true, null, [event('now')]).kind).toBe('message')
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
const event = (delivery: DeliveryTiming): ChannelInput => ({
  source: 'channel',
  kind: 'deploy',
  channel: 'Deploys',
  channel_id: 'hook',
  event_id: 1,
  severity: 'info',
  subject: 'ci',
  title: 'Deploy failed',
  body: '',
  url: null,
  received_at: PAUSED,
  delivery,
})
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

  it('keeps updates held for the next message through automatic turns, until a hand-over or a message', () => {
    const prompt = (id: number, payload: Extract<MessageRow, { kind: 'prompt' }>['payload']): MessageRow => ({
      id,
      task_id: 't',
      outward: [],
      created_at: PAUSED,
      kind: 'prompt',
      payload,
    })
    const rows: MessageRow[] = [
      inputRow(1, event('with_message')),
      inputRow(2, review),
      prompt(3, { text: '', auto: true, inputs: 1 }),
      inputRow(4, event('now')),
    ]
    expect(queuedInputs(rows).map((row) => row.id)).toEqual([1, 4])
    expect(queuedInputs([...rows, prompt(5, { text: '', auto: true, held: true, inputs: 2 })])).toEqual([])
    expect(queuedInputs([...rows, prompt(5, { text: 'morning', inputs: 2 })])).toEqual([])
  })
})
