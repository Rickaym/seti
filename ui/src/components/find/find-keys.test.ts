import { describe, expect, it } from 'vitest'
import { textFindKey } from './find-keys'

const stroke = (key: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key,
  code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

describe('textFindKey', () => {
  it('reads the editor keys with Ctrl outside Apple', () => {
    expect(textFindKey(stroke('f', { ctrlKey: true }), false)).toBe('find')
    expect(textFindKey(stroke('h', { ctrlKey: true }), false)).toBe('replace')
    expect(textFindKey(stroke('g', { ctrlKey: true }), false)).toBe('line')
    expect(textFindKey(stroke('F3'), false)).toBe('next')
    expect(textFindKey(stroke('F3', { shiftKey: true }), false)).toBe('previous')
  })

  it('reads Cmd on Apple, with Cmd+Opt+F to replace and Cmd+G to step', () => {
    expect(textFindKey(stroke('f', { metaKey: true }), true)).toBe('find')
    expect(textFindKey({ ...stroke('f', { metaKey: true, altKey: true }), key: '\u0192' }, true)).toBe('replace')
    expect(textFindKey(stroke('h', { metaKey: true }), true)).toBeNull()
    expect(textFindKey(stroke('g', { ctrlKey: true }), true)).toBe('line')
    expect(textFindKey(stroke('g', { metaKey: true }), true)).toBe('next')
    expect(textFindKey(stroke('g', { metaKey: true, shiftKey: true }), true)).toBe('previous')
  })

  it('leaves other keys and extra modifiers alone', () => {
    expect(textFindKey(stroke('f'), false)).toBeNull()
    expect(textFindKey(stroke('h', { ctrlKey: true, shiftKey: true }), false)).toBeNull()
    expect(textFindKey(stroke('g', { ctrlKey: true, altKey: true }), false)).toBeNull()
    expect(textFindKey(stroke('F3', { ctrlKey: true }), false)).toBeNull()
    expect(textFindKey(stroke('g', { metaKey: true }), false)).toBeNull()
  })
})
