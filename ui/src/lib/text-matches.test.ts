import { describe, expect, it } from 'vitest'
import { findMatches, matchFrom, replaceAllEdit, replaceOneEdit, stepMatch, type TextEdit } from './text-matches'

const applyEdit = (text: string, edit: TextEdit) => `${text.slice(0, edit.from)}${edit.insert}${text.slice(edit.to)}`

const loose = (text: string) => ({ text, caseSensitive: false })
const exact = (text: string) => ({ text, caseSensitive: true })

describe('findMatches', () => {
  it('counts every match, in any case unless case is asked for', () => {
    const text = 'Cat cat CAT scatter'
    expect(findMatches(text, loose('cat')).matches).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
      { from: 8, to: 11 },
      { from: 13, to: 16 },
    ])
    expect(findMatches(text, exact('cat')).matches).toEqual([
      { from: 4, to: 7 },
      { from: 13, to: 16 },
    ])
  })

  it('takes the query literally and finds nothing for an empty one', () => {
    expect(findMatches('a.b axb (a.b)', loose('(a.b)')).matches).toEqual([{ from: 8, to: 13 }])
    expect(findMatches('a.b axb', loose('a.b')).matches).toHaveLength(1)
    expect(findMatches('anything', loose(''))).toEqual({ matches: [], capped: false })
  })

  it('stops at the limit and says more lie past it', () => {
    const found = findMatches('aaaaa', loose('a'), 3)
    expect(found.matches).toHaveLength(3)
    expect(found.capped).toBe(true)
  })
})

describe('stepping', () => {
  const matches = findMatches('x one x two x', loose('x')).matches

  it('starts at the first match at or after the caret, wrapping to the first', () => {
    expect(matchFrom(matches, 0)).toBe(0)
    expect(matchFrom(matches, 1)).toBe(1)
    expect(matchFrom(matches, 7)).toBe(2)
    expect(matchFrom(matches, 13)).toBe(0)
    expect(matchFrom([], 0)).toBe(-1)
  })

  it('steps forward and back, wrapping at both ends', () => {
    expect(stepMatch(0, 3, 1)).toBe(1)
    expect(stepMatch(2, 3, 1)).toBe(0)
    expect(stepMatch(0, 3, -1)).toBe(2)
    expect(stepMatch(-1, 3, 1)).toBe(0)
    expect(stepMatch(-1, 3, -1)).toBe(2)
    expect(stepMatch(0, 0, 1)).toBe(-1)
  })
})

describe('replacing', () => {
  it('replaces one match', () => {
    const text = 'red, red, red'
    const [, second] = findMatches(text, loose('red')).matches
    expect(second).toBeDefined()
    if (second !== undefined) {
      expect(applyEdit(text, replaceOneEdit(second, 'blue'))).toBe('red, blue, red')
    }
  })

  it('replaces every match in one edit from the first to the last', () => {
    const text = 'say Red, red and RED.'
    const edit = replaceAllEdit(text, loose('red'), 'blue')
    expect(edit).toEqual({ from: 4, to: 20, insert: 'blue, blue and blue' })
    expect(edit === null ? text : applyEdit(text, edit)).toBe('say blue, blue and blue.')
  })

  it('keeps case when asked, and takes the replacement literally', () => {
    const text = 'Red red'
    const edit = replaceAllEdit(text, exact('red'), '$& $1')
    expect(edit === null ? text : applyEdit(text, edit)).toBe('Red $& $1')
    expect(replaceAllEdit(text, exact('blue'), 'x')).toBeNull()
  })

  it('replaces past the counting limit', () => {
    const text = 'a'.repeat(1500)
    const edit = replaceAllEdit(text, loose('a'), 'b')
    expect(edit === null ? text : applyEdit(text, edit)).toBe('b'.repeat(1500))
  })
})
