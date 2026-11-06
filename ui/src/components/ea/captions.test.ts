import { describe, expect, it } from 'vitest'
import { captionsReducer, initialCaptions, type CaptionEvent, type CaptionItem } from './captions'

const run = (events: CaptionEvent[]) => events.reduce(captionsReducer, initialCaptions)

function lines(items: readonly CaptionItem[]): string[] {
  return items.map((item) => {
    switch (item.kind) {
      case 'user':
      case 'bot':
        return `${item.kind}${item.final ? '' : '*'} ${item.text}`
      case 'action':
        return `action ${item.tool} ${item.running ? 'running' : String(item.ok)} ${item.summary ?? '-'}`
      case 'marker':
        return `marker ${item.text}`
    }
  })
}

describe('captionsReducer', () => {
  it('replaces an interim user caption until it is final, then starts a new one', () => {
    const state = run([
      { type: 'user', text: 'what is', final: false, at: 1 },
      { type: 'user', text: 'What is running?', final: true, at: 2 },
      { type: 'user', text: 'And', final: false, at: 3 },
    ])
    expect(lines(state.items)).toEqual(['user What is running?', 'user* And'])
  })

  it('rebuilds bot captions from the spoken prefix of each segment', () => {
    const state = run([
      { type: 'bot-started' },
      { type: 'bot-segment', segment: 1, spoken: 'Two tasks', at: 1 },
      { type: 'bot-segment', segment: 1, spoken: 'Two tasks are running.', at: 2 },
      { type: 'bot-segment', segment: 2, spoken: 'One needs you.', at: 3 },
      { type: 'bot-stopped' },
      { type: 'bot-segment', segment: 2, spoken: 'One needs you. Now.', at: 4 },
    ])
    expect(lines(state.items)).toEqual(['bot Two tasks are running. One needs you. Now.'])
  })

  it('keeps a user turn that interrupts the bot between two bot captions', () => {
    const state = run([
      { type: 'bot-segment', segment: 1, spoken: 'The first task', at: 1 },
      { type: 'user', text: 'Stop.', final: true, at: 2 },
      { type: 'bot-started' },
      { type: 'bot-segment', segment: 2, spoken: 'Stopped.', at: 3 },
    ])
    expect(lines(state.items)).toEqual(['bot* The first task', 'user Stop.', 'bot* Stopped.'])
  })

  it('shows a call as running, then fills in the report of the action', () => {
    const state = run([
      { type: 'call-started', tool: 'send_message', callId: 'c1', at: 1 },
      { type: 'call-started', tool: 'send_message', callId: 'c1', at: 1 },
      { type: 'call-started', tool: 'send_message', callId: 'c2', at: 2 },
      { type: 'call-stopped', tool: 'send_message', callId: 'c1', cancelled: false },
      {
        type: 'action',
        action: { type: 'ea-action', tool: 'send_message', summary: 'Told "Login fix" to rebase', ok: true },
        at: 3,
      },
    ])
    expect(lines(state.items)).toEqual([
      'action send_message true Told "Login fix" to rebase',
      'action send_message running -',
    ])
  })

  it('adds a reported action that had no call event and marks cancelled calls', () => {
    const state = run([
      { type: 'action', action: { type: 'ea-action', tool: 'stop_task', summary: 'Task not found', ok: false }, at: 1 },
      { type: 'call-started', tool: 'list_prs', callId: 'c3', at: 2 },
      { type: 'call-stopped', tool: 'list_prs', callId: 'other', cancelled: true },
    ])
    expect(lines(state.items)).toEqual(['action stop_task false Task not found', 'action list_prs false Cancelled'])
  })

  it('keeps a bot caption open across an action and closes it at a marker', () => {
    const state = run([
      { type: 'bot-segment', segment: 1, spoken: 'Checking.', at: 1 },
      { type: 'call-started', tool: 'list_tasks', callId: 'c4', at: 2 },
      { type: 'bot-segment', segment: 2, spoken: 'Done.', at: 3 },
      { type: 'marker', text: 'Call ended', at: 4 },
    ])
    expect(lines(state.items)).toEqual(['bot Checking. Done.', 'action list_tasks running -', 'marker Call ended'])
  })
})
