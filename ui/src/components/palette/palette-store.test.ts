import { describe, expect, it } from 'vitest'
import { isPaletteShortcut } from './palette-store'
import { withRecent } from './recent'

const chord = (extra: Partial<Parameters<typeof isPaletteShortcut>[0]> = {}) => ({
  code: 'KeyK',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
})

describe('isPaletteShortcut', () => {
  it('takes Ctrl+K off Apple devices and Cmd+K on them', () => {
    expect(isPaletteShortcut(chord({ ctrlKey: true }), false)).toBe(true)
    expect(isPaletteShortcut(chord({ metaKey: true }), false)).toBe(false)
    expect(isPaletteShortcut(chord({ metaKey: true }), true)).toBe(true)
    expect(isPaletteShortcut(chord({ ctrlKey: true }), true)).toBe(false)
  })

  it('leaves other keys and chords with Shift or Alt alone', () => {
    expect(isPaletteShortcut(chord(), false)).toBe(false)
    expect(isPaletteShortcut(chord({ ctrlKey: true, shiftKey: true }), false)).toBe(false)
    expect(isPaletteShortcut(chord({ ctrlKey: true, altKey: true }), false)).toBe(false)
    expect(isPaletteShortcut(chord({ ctrlKey: true, code: 'KeyL' }), false)).toBe(false)
  })
})

describe('withRecent', () => {
  it('moves the id to the front without duplicates and keeps the newest few', () => {
    expect(withRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    expect(withRecent(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b'])
  })
})
