import { afterEach, describe, expect, it, vi } from 'vitest'
import { modChords, parseModChord, registerModChord } from '@/mods/mod-chords'

vi.mock('@/components/shortcuts/chords', async () => {
  vi.stubGlobal('navigator', { userAgent: 'Linux' })
  return import('@/components/shortcuts/chords')
})

const disposers: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose()
  }
})

const bind = (key: string, chord: string, owner = 'Panels') =>
  registerModChord({ key, chord: parseModChord(chord), owner, run: () => undefined })

describe('mod chords', () => {
  it('reads Alt and Ctrl chords with Shift, letters, digits, arrows and brackets', () => {
    expect(parseModChord('Alt+G')).toEqual({ code: 'KeyG', key: 'G', modifier: 'alt' })
    expect(parseModChord('Ctrl+Shift+Left')).toEqual({
      code: 'ArrowLeft',
      key: 'Left',
      modifier: 'primary',
      shift: true,
    })
    expect(parseModChord('Alt+7')).toEqual({ code: 'Digit7', key: '7', modifier: 'alt' })
    expect(parseModChord('Alt+]')).toEqual({ code: 'BracketRight', key: ']', modifier: 'alt' })
    expect(() => parseModChord('G')).toThrow('G is not a chord')
  })

  it("refuses a chord Seti binds, or another mod's, and frees it once that mod stops", () => {
    expect(() => bind('panels.new', 'Alt+N')).toThrow('Alt+N is taken by Seti')
    expect(() => bind('panels.palette', 'Ctrl+K')).toThrow('Ctrl+K is taken by Seti')
    const first = bind('other.go', 'Alt+J', 'Other')
    expect(() => bind('panels.go', 'Alt+J')).toThrow('Alt+J is taken by Other')
    disposers.push(bind('panels.shifted', 'Alt+Shift+J'))
    first()
    disposers.push(bind('panels.go', 'Alt+J'))
    expect(modChords.list().map((entry) => entry.key)).toEqual(['panels.shifted', 'panels.go'])
  })
})
