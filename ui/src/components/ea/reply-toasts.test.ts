import type { AttentionBrief, EaAsk, EaUnseenReplies, EaUnseenReply } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { askLabel, BRIEF_KEY, nextSettle, replyKey, replyToasts, SETTLE_MS, type ReplyToastInput } from './reply-toasts'

const NOW = Date.parse('2026-11-03T12:00:00.000Z')
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const ask = (id: number): EaAsk => ({
  id,
  tool: 'delete_agent',
  summary: 'delete agent Old',
  state: 'pending',
  detail: null,
  expires_at: at(-60_000),
})

const reply = (id: number, extra: Partial<EaUnseenReply> = {}): EaUnseenReply => ({
  id,
  text: `Reply ${String(id)}`,
  created_at: at(60_000),
  asks: [],
  ...extra,
})

const page = (replies: EaUnseenReply[], total = replies.length): EaUnseenReplies => ({ replies, total })

const input = (over: Partial<ReplyToastInput>): ReplyToastInput => ({
  page: page([reply(1)]),
  brief: null,
  calling: false,
  chatShown: false,
  toasts: true,
  now: NOW,
  ...over,
})

const BRIEF: AttentionBrief = {
  id: 'b1',
  since: at(3_600_000),
  at: at(0),
  needs_you: [],
  changed: [{ task_id: 't1', title: 'Speech', text: 'Opened PR #12', url: '/#agents/t1' }],
  more: 0,
  summary: 'One agent finished.',
}

const keys = (over: Partial<ReplyToastInput>) => replyToasts(input(over)).map((toast) => toast.key)

describe('EA reply toasts', () => {
  it('toasts each unseen reply while no call runs and the chat is not on screen', () => {
    expect(keys({ page: page([reply(1), reply(2)]) })).toEqual([replyKey(1), replyKey(2)])
  })

  it('stays quiet during a call, while the EA chat shows, with the active tier quiet and before data', () => {
    expect(keys({ calling: true, brief: BRIEF })).toEqual([])
    expect(keys({ chatShown: true })).toEqual([])
    expect(keys({ toasts: false })).toEqual([])
    expect(keys({ page: undefined })).toEqual([])
  })

  it('waits a moment for an open chat elsewhere to mark a new reply seen', () => {
    const fresh = page([reply(1, { created_at: at(SETTLE_MS - 1000) })])
    expect(keys({ page: fresh })).toEqual([])
    expect(nextSettle(fresh, NOW)).toBe(1000)
    expect(keys({ page: fresh, now: NOW + 1000 })).toEqual([replyKey(1)])
    expect(nextSettle(page([reply(1)]), NOW)).toBeNull()
  })

  it('folds a burst of plain replies into one brief, counting those past the page', () => {
    const four = page([reply(5), reply(6), reply(7), reply(8)])
    expect(replyToasts(input({ page: four }))).toEqual([
      { kind: 'brief', key: BRIEF_KEY, brief: null, replies: four.replies, beyond: 0, seen: { ids: [5, 6, 7, 8] } },
    ])
    const paged = page([reply(9), reply(10)], 6)
    expect(replyToasts(input({ page: paged }))).toMatchObject([
      { kind: 'brief', beyond: 4, seen: { ids: [9, 10], through: 8 } },
    ])
    expect(keys({ page: page([reply(1), reply(2), reply(3)]) })).toHaveLength(3)
  })

  it('shows the brief with every plain message folded in, even while the active tier is quiet', () => {
    expect(replyToasts(input({ brief: BRIEF, toasts: false }))).toEqual([
      { kind: 'brief', key: BRIEF_KEY, brief: BRIEF, replies: [reply(1)], beyond: 0, seen: { ids: [1] } },
    ])
    expect(replyToasts(input({ brief: BRIEF, page: page([]) }))).toMatchObject([{ kind: 'brief', seen: null }])
  })

  it('keeps a reply that asks a question apart from a burst, with its buttons', () => {
    const asking = reply(9, { asks: [ask(4)] })
    const toasts = replyToasts(input({ page: page([reply(5), reply(6), reply(7), reply(8), asking]) }))
    expect(toasts.map((toast) => toast.key)).toEqual([BRIEF_KEY, replyKey(9)])
    expect(toasts[1]).toMatchObject({ kind: 'reply', reply: { asks: [{ id: 4 }] } })
  })

  it('names a question with a capital first letter', () => {
    expect(askLabel('delete agent Old')).toBe('Delete agent Old')
  })
})
