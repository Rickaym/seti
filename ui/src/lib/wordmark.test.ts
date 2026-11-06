import { describe, expect, it } from 'vitest'
import { decode, NOISE, PHRASE, SETTLE_MS, TOKENS } from '@/lib/wordmark'

const words = TOKENS.flatMap((token) => (token.kind === 'word' ? [token] : []))

function lockTimes(): number[] {
  return words.flatMap((word) =>
    Array.from(word.tail, (_, index) => {
      let ms = 0
      while (decode(word.tail, word.at, ms)[index]?.state !== 'lock') {
        ms += 1
      }
      return ms
    }),
  )
}

describe('wordmark', () => {
  it('spells SETI with its capitals at their places in the phrase', () => {
    expect(words.map((word) => word.capital).join('')).toBe('SETI')
    for (const word of words) {
      expect(PHRASE.slice(word.at, word.at + 1 + word.tail.length)).toBe(word.capital + word.tail)
    }
    expect(TOKENS.flatMap((token) => (token.kind === 'link' ? [token.text] : []))).toEqual(['of'])
  })

  it('hides each tail at first, scrambles it in thin marks and locks every letter by the end', () => {
    const individuals = words[3]
    expect(individuals?.capital).toBe('I')
    const at = individuals?.at ?? 0
    expect(decode('ndividuals', at, 0).every((glyph) => glyph.state === 'wait')).toBe(true)
    const middle = decode('actical', words[2]?.at ?? 0, 400)
    expect(middle.map((glyph) => glyph.state)).toContain('noise')
    for (const glyph of middle) {
      expect(NOISE).toContain(glyph.noise)
    }
    expect(SETTLE_MS).toBeGreaterThan(500)
    expect(SETTLE_MS).toBeLessThan(700)
    for (const word of words) {
      const glyphs = decode(word.tail, word.at, SETTLE_MS)
      expect(glyphs.map((glyph) => glyph.char).join('')).toBe(word.tail)
      expect(glyphs.every((glyph) => glyph.state === 'lock')).toBe(true)
    }
  })

  it('locks letters one after another from left to right', () => {
    const times = lockTimes()
    expect(times).toEqual([...new Set(times)].sort((a, b) => a - b))
    expect(times.at(-1)).toBe(SETTLE_MS)
  })
})
