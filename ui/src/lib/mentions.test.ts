import { describe, expect, it } from 'vitest'
import { insertMention, mentionAt, rankMentions, type MentionOption } from './mentions'

const options: MentionOption[] = [
  { handle: 'all', detail: 'Every active task', quiet: false },
  { handle: 'ea', detail: 'The EA', quiet: false },
  { handle: 'user', detail: 'You', quiet: false },
  { handle: 'voicemail', detail: 'Fix voicemail detection', quiet: false },
  { handle: 'voice-agent', detail: 'Voice agent', quiet: true },
  { handle: 'billing', detail: 'Billing export', quiet: false },
  { handle: 'api-voice', detail: 'Voice API', quiet: false },
]

describe('mentionAt', () => {
  it('finds the @word the caret is in', () => {
    expect(mentionAt('hi @voi', 7)).toEqual({ start: 3, query: 'voi' })
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionAt('(@Bil', 5)).toEqual({ start: 1, query: 'bil' })
  })

  it('ignores emails, finished words and text after a space', () => {
    expect(mentionAt('me@exa', 6)).toBeNull()
    expect(mentionAt('@voicemail done', 15)).toBeNull()
    expect(mentionAt('plain text', 10)).toBeNull()
    expect(mentionAt('see ./@scope', 12)).toBeNull()
  })
})

describe('rankMentions', () => {
  it('puts prefix matches first, quiet tasks after, and keeps to the limit', () => {
    expect(rankMentions(options, 'voice', 5).map((o) => o.handle)).toEqual(['voicemail', 'voice-agent', 'api-voice'])
    expect(rankMentions(options, '', 3).map((o) => o.handle)).toEqual(['all', 'api-voice', 'billing'])
    expect(rankMentions(options, 'zzz', 5)).toEqual([])
  })
})

describe('insertMention', () => {
  it('replaces the typed part with the handle and a space', () => {
    expect(insertMention('hi @voi', 3, 7, 'voicemail')).toEqual({ text: 'hi @voicemail ', caret: 14 })
  })

  it('replaces the rest of the word after the caret and keeps the text that follows', () => {
    expect(insertMention('@vo please', 0, 3, 'voicemail')).toEqual({ text: '@voicemail please', caret: 11 })
    expect(insertMention('@voxx please', 0, 3, 'voicemail')).toEqual({ text: '@voicemail please', caret: 11 })
  })
})
