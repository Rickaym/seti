import { describe, expect, it } from 'vitest'
import { chordAria, chordLabel, CHORDS, matchesChord, sectionChord, type Chord } from './chords'

type Stroke = Parameters<typeof matchesChord>[0]

const stroke = (code: string, extra: Partial<Omit<Stroke, 'getModifierState'>> & { altGraph?: boolean } = {}) => {
  const { altGraph = false, ...rest } = extra
  return {
    code,
    key: '',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    target: null,
    getModifierState: (name: string) => altGraph && name === 'AltGraph',
    ...rest,
  }
}

describe('matchesChord', () => {
  it('takes Alt with the physical key and nothing bare', () => {
    expect(matchesChord(stroke('KeyN', { altKey: true }), CHORDS.newAgent, false)).toBe(true)
    expect(matchesChord(stroke('KeyN', { altKey: true, key: 'Dead' }), CHORDS.newAgent, true)).toBe(true)
    expect(matchesChord(stroke('KeyN'), CHORDS.newAgent, false)).toBe(false)
    expect(matchesChord(stroke('Digit3', { altKey: true }), sectionChord(3), false)).toBe(true)
    expect(matchesChord(stroke('Digit3'), sectionChord(3), false)).toBe(false)
  })

  it('leaves other modifiers, AltGr and composition alone', () => {
    for (const extra of [
      { altKey: true, ctrlKey: true },
      { altKey: true, metaKey: true },
      { altKey: true, shiftKey: true },
      { altKey: true, altGraph: true },
      { altKey: true, isComposing: true },
      { altKey: true, key: 'Process' },
    ]) {
      expect(matchesChord(stroke('KeyN', extra), CHORDS.newAgent, false)).toBe(false)
    }
  })

  it('takes Ctrl+/ for the guide, Cmd+/ on Apple', () => {
    expect(matchesChord(stroke('Slash', { ctrlKey: true }), CHORDS.guide, false)).toBe(true)
    expect(matchesChord(stroke('Slash', { metaKey: true }), CHORDS.guide, false)).toBe(false)
    expect(matchesChord(stroke('Slash', { metaKey: true }), CHORDS.guide, true)).toBe(true)
    expect(matchesChord(stroke('Slash', { ctrlKey: true }), CHORDS.guide, true)).toBe(false)
    expect(matchesChord(stroke('Slash', { altKey: true }), CHORDS.guide, false)).toBe(false)
    expect(matchesChord(stroke('Slash', { altKey: true }), CHORDS.filterAgents, false)).toBe(true)
  })

  it('steps through your own messages on Alt+[ and Alt+], clear of every other chord', () => {
    expect(matchesChord(stroke('BracketLeft', { altKey: true }), CHORDS.ownBack, false)).toBe(true)
    expect(matchesChord(stroke('BracketRight', { altKey: true }), CHORDS.ownForward, false)).toBe(true)
    expect(chordLabel(CHORDS.ownBack, true)).toBe('Opt+[')
    const codes = Object.values(CHORDS).map((chord: Chord) => `${chord.modifier}:${chord.code}:${String(chord.shift)}`)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('tells Alt+Shift chords from Alt ones', () => {
    const left: Chord = { code: 'ArrowLeft', key: 'Left', modifier: 'alt' }
    const shiftedLeft: Chord = { ...left, shift: true }
    const shifted = stroke('ArrowLeft', { altKey: true, shiftKey: true })
    expect(matchesChord(shifted, shiftedLeft, false)).toBe(true)
    expect(matchesChord(shifted, left, false)).toBe(false)
    expect(matchesChord(stroke('ArrowLeft', { altKey: true }), shiftedLeft, false)).toBe(false)
  })
})

describe('chord names', () => {
  it('reads per platform and in aria-keyshortcuts syntax', () => {
    expect(chordLabel(CHORDS.newAgent, false)).toBe('Alt+N')
    expect(chordLabel(CHORDS.newAgent, true)).toBe('Opt+N')
    expect(chordLabel(CHORDS.guide, false)).toBe('Ctrl+/')
    expect(chordLabel(CHORDS.guide, true)).toBe('Cmd+/')
    expect(chordAria(sectionChord(2), true)).toBe('Alt+2')
    expect(chordAria(CHORDS.guide, false)).toBe('Control+/')
    expect(chordAria(CHORDS.guide, true)).toBe('Meta+/')
    const shiftedUp: Chord = { code: 'ArrowUp', key: 'Up', modifier: 'alt', shift: true }
    expect(chordLabel(shiftedUp, true)).toBe('Opt+Shift+Up')
    expect(chordAria(shiftedUp, false)).toBe('Alt+Shift+Up')
  })
})
