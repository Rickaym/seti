import type { EaHistoryEntry, EaLlmMessage } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { captionsReducer, initialCaptions, type CaptionEvent } from '@/components/ea/captions'
import { inFlight, settledCount, type FeedItem } from './call-feed'

const AT = '2026-09-29T09:00:00.000Z'

const entry = (id: number, message: EaLlmMessage, kind: EaHistoryEntry['kind'] = 'message'): EaHistoryEntry => ({
  id,
  kind,
  message,
  through_id: null,
  created_at: AT,
})

const MARKER = entry(1, { role: 'developer', content: 'A new call started.' }, 'call')

const captions = (events: CaptionEvent[]) => events.reduce(captionsReducer, initialCaptions).items

function line(item: FeedItem): string {
  if (item.kind === 'action') {
    return `action ${item.tool}${item.running ? '*' : ''}`
  }
  return `${item.kind}${item.final ? '' : '*'} ${item.text}`
}

const lines = (items: readonly FeedItem[]) => items.map(line)

const TURN: CaptionEvent[] = [
  { type: 'marker', text: 'Call started', at: 1 },
  { type: 'user', text: 'Which PRs need me?', final: true, at: 2 },
  { type: 'call-started', tool: 'list_prs', callId: 'x1', at: 3 },
  { type: 'call-stopped', tool: 'list_prs', callId: 'x1', cancelled: false },
  { type: 'bot-started' },
  { type: 'bot-segment', segment: 1, spoken: 'Let me look. Three PRs are open.', at: 4 },
]

describe('inFlight', () => {
  it('shows the whole turn until the stored conversation has any of it', () => {
    const items = captions(TURN)
    expect(lines(inFlight(items, [MARKER]))).toEqual([
      'user Which PRs need me?',
      'action list_prs',
      'bot* Let me look. Three PRs are open.',
    ])
    expect(settledCount(items)).toBe(2)
  })

  it('drops what is stored and keeps the line still being spoken', () => {
    const stored = [
      MARKER,
      entry(2, { role: 'user', content: 'Which PRs need me?' }),
      entry(3, {
        role: 'assistant',
        content: 'Let me look.',
        tool_calls: [{ id: 'x1', type: 'function', function: { name: 'list_prs', arguments: '{}' } }],
      }),
      entry(4, { role: 'tool', tool_call_id: 'x1', content: '"3 PRs"' }),
    ]
    expect(lines(inFlight(captions(TURN), stored))).toEqual(['bot* Let me look. Three PRs are open.'])

    const spoken = captions([...TURN, { type: 'bot-stopped' }])
    expect(lines(inFlight(spoken, stored))).toEqual(['bot Let me look. Three PRs are open.'])
    const answered = [...stored, entry(5, { role: 'assistant', content: 'Three PRs are **open**.' })]
    expect(inFlight(spoken, answered)).toEqual([])
  })

  it('clears a finished line it cannot match once a later one is stored', () => {
    const items = captions([
      { type: 'user', text: 'uh, the login', final: true, at: 1 },
      { type: 'bot-segment', segment: 1, spoken: 'Done.', at: 2 },
      { type: 'bot-stopped' },
      { type: 'user', text: 'Thanks', final: true, at: 3 },
      { type: 'user', text: 'and the', final: false, at: 4 },
    ])
    const stored = [MARKER, entry(2, { role: 'user', content: 'Thanks' })]
    expect(lines(inFlight(items, stored))).toEqual(['user* and the'])
  })

  it('ignores typed turns and earlier calls', () => {
    const items = captions([{ type: 'user', text: 'Yes', final: true, at: 1 }])
    const typed = [entry(1, { role: 'user', content: 'Yes' }, 'chat')]
    expect(lines(inFlight(items, typed))).toEqual(['user Yes'])
    const earlier = [entry(1, { role: 'user', content: 'Yes' }), MARKER]
    expect(lines(inFlight(items, earlier))).toEqual(['user Yes'])
  })
})
