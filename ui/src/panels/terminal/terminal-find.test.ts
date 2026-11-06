import { describe, expect, it } from 'vitest'
import { isFindChord, matchLabel } from './terminal-find'

const keys = (key: string, held: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean }) => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...held,
})

describe('isFindChord', () => {
  it('opens find on Ctrl+Shift+F, and on Cmd+F on a Mac', () => {
    expect(isFindChord(keys('F', { ctrlKey: true, shiftKey: true }), false)).toBe(true)
    expect(isFindChord(keys('f', { metaKey: true }), true)).toBe(true)
    expect(isFindChord(keys('F', { ctrlKey: true, shiftKey: true }), true)).toBe(true)
  })

  it('leaves Ctrl+F to the shell, which moves the cursor with it', () => {
    expect(isFindChord(keys('f', { ctrlKey: true }), false)).toBe(false)
    expect(isFindChord(keys('f', { metaKey: true }), false)).toBe(false)
    expect(isFindChord(keys('g', { ctrlKey: true, shiftKey: true }), false)).toBe(false)
  })
})

describe('matchLabel', () => {
  it('counts matches and names the one shown', () => {
    expect(matchLabel(-1, 0)).toBe('No matches')
    expect(matchLabel(-1, 4)).toBe('4 matches')
    expect(matchLabel(2, 4)).toBe('3 of 4')
  })
})
