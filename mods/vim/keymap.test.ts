import { describe, expect, it } from 'vitest'
import { readKey, SEQUENCE_MS, type KeyContext, type KeyStroke } from './keymap'
import { vimActive } from './vim-store'

const NORMAL: KeyContext = {
  enabled: true,
  typing: false,
  passthrough: false,
  terminal: false,
  overlay: false,
  finding: false,
}

const TERMINAL: KeyContext = { ...NORMAL, typing: true, passthrough: true, terminal: true }

const LEADER = { key: 'Ctrl+\\', at: 1000 } as const

const stroke = (key: string, extra: Partial<KeyStroke> = {}): KeyStroke => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  ...extra,
})

const read = (key: string, context: Partial<KeyContext> = {}, extra: Partial<KeyStroke> = {}) =>
  readKey(stroke(key, extra), { ...NORMAL, ...context }, null, 0)

describe('readKey', () => {
  it('is off until turned on', () => {
    expect(vimActive()).toBe(false)
    for (const key of ['j', 'k', 'h', 'l', '/', '?', 'G', 'Escape']) {
      expect(read(key, { enabled: false })).toEqual({ action: null, handled: false, pending: null })
    }
  })

  it('scrolls, moves between panels and opens find in normal mode', () => {
    expect(read('j').action).toEqual({ type: 'scroll', by: 'line', direction: 1 })
    expect(read('k').action).toEqual({ type: 'scroll', by: 'line', direction: -1 })
    expect(read('d', {}, { ctrlKey: true }).action).toEqual({ type: 'scroll', by: 'half', direction: 1 })
    expect(read('u', {}, { ctrlKey: true }).action).toEqual({ type: 'scroll', by: 'half', direction: -1 })
    expect(read('G').action).toEqual({ type: 'edge', to: 'bottom' })
    expect(read('l').action).toEqual({ type: 'panel', to: 'next' })
    expect(read('h').action).toEqual({ type: 'panel', to: 'previous' })
    expect(read('J').action).toEqual({ type: 'panel', to: 'down' })
    expect(read('3').action).toEqual({ type: 'panelAt', index: 2 })
    expect(read('i').action).toEqual({ type: 'insert', at: 'keep' })
    expect(read('/').action).toEqual({ type: 'find' })
    expect(read('n').action).toEqual({ type: 'findStep', direction: 'next' })
    expect(read('?').action).toEqual({ type: 'help' })
    expect(read('l').handled).toBe(true)
  })

  it('leaves unbound keys and other modifiers to the page', () => {
    for (const key of ['x', 'q', '0', 'Enter', ' ', 'Tab', 'ArrowDown']) {
      expect(read(key).handled).toBe(false)
    }
    expect(read('j', {}, { altKey: true }).handled).toBe(false)
    expect(read('j', {}, { metaKey: true }).handled).toBe(false)
    expect(read('j', {}, { ctrlKey: true }).handled).toBe(false)
    expect(read('f', {}, { ctrlKey: true }).handled).toBe(false)
    expect(read('j', {}, { isComposing: true }).handled).toBe(false)
  })

  it('types in insert mode, where only Esc acts, to leave the field', () => {
    for (const key of ['j', 'l', '/', '?', 'g', 'i']) {
      expect(read(key, { typing: true }).handled).toBe(false)
    }
    expect(read('d', { typing: true }, { ctrlKey: true }).handled).toBe(false)
    expect(read('Escape', { typing: true }).action).toEqual({ type: 'normal' })
  })

  it('takes Esc in normal mode only to close an open find bar', () => {
    expect(read('Escape').handled).toBe(false)
    expect(read('Escape', { finding: true }).action).toEqual({ type: 'closeFind' })
  })

  it('keeps every key, Esc included, away from terminals, frames and open dialogs', () => {
    for (const context of [{ passthrough: true }, { overlay: true }]) {
      for (const key of ['j', 'l', '/', 'G', 'Escape']) {
        expect(read(key, context).handled).toBe(false)
        expect(read(key, { ...context, typing: true }).handled).toBe(false)
      }
    }
  })

  it('reads gg, gf and gc within the timeout and lets other keys after g act as themselves', () => {
    const first = readKey(stroke('g'), NORMAL, null, 1000)
    expect(first).toEqual({ action: null, handled: true, pending: { key: 'g', at: 1000 } })
    expect(readKey(stroke('g'), NORMAL, first.pending, 1500).action).toEqual({ type: 'edge', to: 'top' })
    expect(readKey(stroke('f'), NORMAL, first.pending, 1500).action).toEqual({ type: 'files' })
    expect(readKey(stroke('c'), NORMAL, first.pending, 1500).action).toEqual({ type: 'groupChat' })
    const other = readKey(stroke('j'), NORMAL, first.pending, 1500)
    expect(other).toEqual({ action: { type: 'scroll', by: 'line', direction: 1 }, handled: true, pending: null })
    const late = readKey(stroke('g'), NORMAL, first.pending, 1000 + SEQUENCE_MS + 1)
    expect(late).toEqual({ action: null, handled: true, pending: { key: 'g', at: 1000 + SEQUENCE_MS + 1 } })
    expect(readKey(stroke('f'), NORMAL, first.pending, 1000 + SEQUENCE_MS + 1).handled).toBe(false)
  })

  it('leaves a terminal for normal mode on Ctrl+\\ then n or Ctrl+n', () => {
    const first = readKey(stroke('\\', { ctrlKey: true }), TERMINAL, null, 1000)
    expect(first).toEqual({ action: null, handled: true, pending: LEADER })
    expect(readKey(stroke('Control', { ctrlKey: true }), TERMINAL, first.pending, 1200)).toEqual({
      action: null,
      handled: false,
      pending: LEADER,
    })
    for (const extra of [{}, { ctrlKey: true }]) {
      const leave = readKey(stroke('n', extra), TERMINAL, first.pending, 1500)
      expect(leave).toEqual({ action: { type: 'normal' }, handled: true, pending: null })
    }
  })

  it('passes every other terminal key to the shell, and a second Ctrl+\\ too', () => {
    for (const key of ['j', 'l', 'n', 'i', '/', ':', 'Escape', 'g']) {
      expect(readKey(stroke(key), TERMINAL, null, 1500).handled).toBe(false)
    }
    for (const key of ['x', 'Escape', 'c', 'N']) {
      expect(readKey(stroke(key, { ctrlKey: key === 'c' }), TERMINAL, LEADER, 1500)).toEqual({
        action: null,
        handled: false,
        pending: null,
      })
    }
    const twice = readKey(stroke('\\', { ctrlKey: true }), TERMINAL, LEADER, 1200)
    expect(twice).toEqual({ action: null, handled: false, pending: null })
    expect(readKey(stroke('n'), TERMINAL, LEADER, 1000 + SEQUENCE_MS + 1).handled).toBe(false)
    expect(readKey(stroke('n', { altKey: true }), TERMINAL, LEADER, 1500).handled).toBe(false)
    expect(readKey(stroke('\\', { ctrlKey: true, altKey: true }), TERMINAL, null, 1500).handled).toBe(false)
  })

  it('takes no terminal key while off or under a dialog, and Ctrl+\\ waits only in a terminal', () => {
    for (const context of [{ enabled: false }, { overlay: true }]) {
      const leader = readKey(stroke('\\', { ctrlKey: true }), { ...TERMINAL, ...context }, null, 1000)
      expect(leader).toEqual({ action: null, handled: false, pending: null })
      expect(readKey(stroke('n'), { ...TERMINAL, ...context }, LEADER, 1500).handled).toBe(false)
    }
    expect(readKey(stroke('g'), NORMAL, LEADER, 1500).pending).toEqual({ key: 'g', at: 1500 })
    expect(readKey(stroke('n', { ctrlKey: true }), NORMAL, LEADER, 1500).handled).toBe(false)
  })
})
