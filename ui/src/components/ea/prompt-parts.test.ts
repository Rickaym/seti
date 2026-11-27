import type { EaPromptPart } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { chars, matchCount, partOpen, pieces, sizeText } from './prompt-parts'

const part = (key: EaPromptPart['key'], text: string): EaPromptPart => ({
  key,
  label: key,
  about: '',
  text,
  chars: text.length,
  per_turn: key !== 'base',
  built_at: null,
})

const PARTS = [part('base', 'x'.repeat(28_000)), part('chat', 'Typing now.'), part('live', '')]

describe('sizeText', () => {
  it('adds the parts and names the short commit', () => {
    expect(sizeText(PARTS, '0123456789abcdef')).toBe('28,011 characters in 3 parts; build 0123456')
    expect(sizeText([part('chat', 'a')], null)).toBe('1 character in 1 part; build unknown')
    expect(chars(0)).toBe('0 characters')
  })
})

describe('pieces', () => {
  it('marks every match whatever its case and keeps the text whole', () => {
    const cut = pieces('Ask first. Then ASK again.', 'ask')
    expect(cut.map((p) => p.text).join('')).toBe('Ask first. Then ASK again.')
    expect(cut.filter((p) => p.match).map((p) => p.from)).toEqual([0, 16])
    expect(pieces('plain', '  ')).toEqual([{ from: 0, text: 'plain', match: false }])
    expect(matchCount('aaaa', 'aa')).toBe(2)
  })
})

describe('partOpen', () => {
  it('follows the user without a search and the matches with one', () => {
    const chat = part('chat', 'Typing now.')
    expect(partOpen(chat, '', new Set())).toBe(false)
    expect(partOpen(chat, '', new Set(['chat']))).toBe(true)
    expect(partOpen(chat, 'typing', new Set())).toBe(true)
    expect(partOpen(chat, 'voice', new Set(['chat']))).toBe(false)
  })
})
