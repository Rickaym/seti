import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chordFont, clampFont, DEFAULT_FONT, fontChord, pinchFont, terminalFont } from './terminal-font'

const press = (key: string, held: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...held,
})

describe('fontChord', () => {
  it('reads Ctrl+=, Ctrl++, Ctrl+- and Ctrl+0, and Cmd on a Mac', () => {
    expect(fontChord(press('=', { ctrlKey: true }), false)).toBe('grow')
    expect(fontChord(press('+', { ctrlKey: true }), false)).toBe('grow')
    expect(fontChord(press('-', { ctrlKey: true }), false)).toBe('shrink')
    expect(fontChord(press('0', { ctrlKey: true }), false)).toBe('reset')
    expect(fontChord(press('=', { metaKey: true }), true)).toBe('grow')
  })

  it('leaves the shell its own keys', () => {
    expect(fontChord(press('='), false)).toBeNull()
    expect(fontChord(press('=', { ctrlKey: true }), true)).toBeNull()
    expect(fontChord(press('-', { ctrlKey: true, altKey: true }), false)).toBeNull()
    expect(fontChord(press('c', { ctrlKey: true }), false)).toBeNull()
  })
})

describe('font sizes', () => {
  it('steps, resets and clamps', () => {
    expect(chordFont(13, 'grow')).toBe(14)
    expect(chordFont(13, 'shrink')).toBe(12)
    expect(chordFont(20, 'reset')).toBe(DEFAULT_FONT)
    expect(chordFont(28, 'grow')).toBe(28)
    expect(clampFont(2)).toBe(8)
  })

  it('scales with a pinch from the size it started at', () => {
    expect(pinchFont(13, 1.5)).toBe(20)
    expect(pinchFont(13, 0.5)).toBe(8)
    expect(pinchFont(20, 10)).toBe(28)
  })
})

describe('terminalFont', () => {
  const items = new Map<string, string>()
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
    })
  })
  afterEach(() => {
    terminalFont.set(DEFAULT_FONT)
    vi.unstubAllGlobals()
  })

  it('remembers the size on this device and tells every terminal', () => {
    const heard: number[] = []
    const stop = terminalFont.subscribe(() => heard.push(terminalFont.get()))
    terminalFont.set(16)
    terminalFont.set(16)
    terminalFont.set(40)
    stop()
    expect(heard).toEqual([16, 28])
    expect(items.get('seti.terminal.fontSize')).toBe('28')
  })
})
