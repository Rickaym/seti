import { describe, expect, it } from 'vitest'
import { selectedUrl, spanBetween, wordAt } from './terminal-select'

describe('wordAt', () => {
  it('takes a whole path, flag or address, and stops at spaces, quotes and brackets', () => {
    const line = 'ls -la ~/src/app.ts "https://x.io/a?b=1" (copy-42-done)'
    expect(wordAt(line, 1)).toEqual({ start: 0, length: 2 })
    expect(wordAt(line, 4)).toEqual({ start: 3, length: 3 })
    expect(wordAt(line, 10)).toEqual({ start: 7, length: 12 })
    expect(wordAt(line, 25)).toEqual({ start: 21, length: 18 })
    expect(wordAt(line, 46)).toEqual({ start: 42, length: 12 })
  })

  it('finds nothing on a gap or past the end', () => {
    expect(wordAt('a b', 1)).toBeNull()
    expect(wordAt('a b', 9)).toBeNull()
  })
})

describe('spanBetween', () => {
  it('spans forward or backward, across rows', () => {
    expect(spanBetween({ col: 2, row: 5 }, { col: 6, row: 5 }, 80)).toEqual({ col: 2, row: 5, length: 5 })
    expect(spanBetween({ col: 6, row: 5 }, { col: 2, row: 5 }, 80)).toEqual({ col: 2, row: 5, length: 5 })
    expect(spanBetween({ col: 78, row: 5 }, { col: 1, row: 6 }, 80)).toEqual({ col: 78, row: 5, length: 4 })
  })
})

describe('selectedUrl', () => {
  it('reads a web address and drops a trailing full stop', () => {
    expect(selectedUrl('https://example.com/docs.')).toBe('https://example.com/docs')
    expect(selectedUrl(' http://localhost:3006/#agents ')).toBe('http://localhost:3006/#agents')
    expect(selectedUrl('example.com')).toBeNull()
    expect(selectedUrl('javascript:alert(1)')).toBeNull()
  })
})
