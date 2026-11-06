import { describe, expect, it } from 'vitest'
import { clipboardChord } from './terminal-clipboard'

const press = (key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) => ({
  key,
  ctrlKey: mods.ctrl === true,
  shiftKey: mods.shift === true,
  altKey: mods.alt === true,
  metaKey: mods.meta === true,
})

describe('clipboardChord', () => {
  it('copies on Ctrl+C only with a selection, so ^C still reaches the shell without one', () => {
    expect(clipboardChord(press('c', { ctrl: true }), true, false)).toBe('copy')
    expect(clipboardChord(press('c', { ctrl: true }), false, false)).toBeNull()
  })

  it('pastes on Ctrl+V, and copies and pastes on Ctrl+Shift+C and V', () => {
    expect(clipboardChord(press('v', { ctrl: true }), false, false)).toBe('paste')
    expect(clipboardChord(press('C', { ctrl: true, shift: true }), false, false)).toBe('copy')
    expect(clipboardChord(press('V', { ctrl: true, shift: true }), false, false)).toBe('paste')
  })

  it('uses Cmd on a Mac and leaves Ctrl to the shell there', () => {
    expect(clipboardChord(press('c', { meta: true }), true, true)).toBe('copy')
    expect(clipboardChord(press('v', { meta: true }), false, true)).toBe('paste')
    expect(clipboardChord(press('c', { ctrl: true }), true, true)).toBeNull()
    expect(clipboardChord(press('v', { ctrl: true }), false, true)).toBeNull()
  })

  it('leaves other keys and Alt chords to the shell', () => {
    expect(clipboardChord(press('d', { ctrl: true }), true, false)).toBeNull()
    expect(clipboardChord(press('c'), true, false)).toBeNull()
    expect(clipboardChord(press('v', { ctrl: true, alt: true }), false, false)).toBeNull()
  })
})
