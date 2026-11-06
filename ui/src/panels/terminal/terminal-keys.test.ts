import { describe, expect, it } from 'vitest'
import {
  keySequence,
  lineKeys,
  newlineKeys,
  pressSequence,
  splitLines,
  withCtrl,
  withModifiers,
  type KeyPress,
} from './terminal-keys'

const CTRL = { ctrl: true, alt: false }
const ALT = { ctrl: false, alt: true }
const BOTH = { ctrl: true, alt: true }

describe('keySequence', () => {
  it('sends escape, tab and arrows in normal or application cursor mode', () => {
    expect(keySequence('Esc', false)).toBe('\x1b')
    expect(keySequence('Tab', true)).toBe('\t')
    expect(keySequence('BackTab', false)).toBe('\x1b[Z')
    expect(keySequence('Up', false)).toBe('\x1b[A')
    expect(keySequence('Left', true)).toBe('\x1bOD')
  })

  it('sends Home, End, Page Up and Page Down as xterm does', () => {
    expect(keySequence('Home', false)).toBe('\x1b[H')
    expect(keySequence('End', true)).toBe('\x1bOF')
    expect(keySequence('PgUp', false)).toBe('\x1b[5~')
    expect(keySequence('PgDn', true)).toBe('\x1b[6~')
  })

  it('adds the xterm modifier parameter to cursor and page keys', () => {
    expect(keySequence('Left', true, CTRL)).toBe('\x1b[1;5D')
    expect(keySequence('Right', false, ALT)).toBe('\x1b[1;3C')
    expect(keySequence('Up', false, BOTH)).toBe('\x1b[1;7A')
    expect(keySequence('Home', false, CTRL)).toBe('\x1b[1;5H')
    expect(keySequence('PgDn', false, ALT)).toBe('\x1b[6;3~')
  })

  it('prefixes Esc for Alt on escape and tab, and leaves Ctrl off them', () => {
    expect(keySequence('Esc', false, ALT)).toBe('\x1b\x1b')
    expect(keySequence('Tab', false, ALT)).toBe('\x1b\t')
    expect(keySequence('Tab', false, CTRL)).toBe('\t')
  })

  it('sends symbols as typed text, with the held modifiers', () => {
    expect(keySequence('|', false)).toBe('|')
    expect(keySequence('_', false, CTRL)).toBe('\x1f')
    expect(keySequence('/', false, ALT)).toBe('\x1b/')
  })
})

describe('withCtrl', () => {
  it('turns one typed letter or symbol into its control character', () => {
    expect(withCtrl('c')).toBe('\x03')
    expect(withCtrl('D')).toBe('\x04')
    expect(withCtrl('[')).toBe('\x1b')
    expect(withCtrl(' ')).toBe('\x00')
    expect(withCtrl('?')).toBe('\x7f')
    expect(withCtrl('1')).toBe('1')
    expect(withCtrl('ls')).toBe('ls')
  })
})

describe('withModifiers', () => {
  it('applies Ctrl, then Alt as an Esc prefix, and leaves text alone without them', () => {
    expect(withModifiers('b', ALT)).toBe('\x1bb')
    expect(withModifiers('c', BOTH)).toBe('\x1b\x03')
    expect(withModifiers('b', { ctrl: false, alt: false })).toBe('b')
    expect(withModifiers('\u{1F600}', ALT)).toBe('\x1b\u{1F600}')
  })

  it('leaves a paste or longer text alone', () => {
    expect(withModifiers('ls', BOTH)).toBe('ls')
    expect(withModifiers('', ALT)).toBe('')
  })
})

describe('Backspace with modifiers', () => {
  it('sends DEL, BS with Ctrl, and Esc first with Alt, as xterm does', () => {
    expect(withModifiers('\x7f', { ctrl: false, alt: false })).toBe('\x7f')
    expect(withModifiers('\x7f', ALT)).toBe('\x1b\x7f')
    expect(withModifiers('\x7f', CTRL)).toBe('\b')
    expect(withModifiers('\x7f', BOTH)).toBe('\x1b\b')
  })
})

describe('lineKeys', () => {
  it('types what a keyboard added after the text the shell already has', () => {
    expect(lineKeys('', 'Thank ')).toEqual(['T', 'h', 'a', 'n', 'k', ' '])
    expect(lineKeys('Thank ', 'Thank you ')).toEqual(['y', 'o', 'u', ' '])
    expect(lineKeys('b', 'bd')).toEqual(['d'])
  })

  it('backspaces to where a correction parts from what was sent, then types the rest', () => {
    expect(lineKeys('echo waether ', 'echo weather ')).toEqual([
      '\x7f',
      '\x7f',
      '\x7f',
      '\x7f',
      '\x7f',
      '\x7f',
      '\x7f',
      'e',
      'a',
      't',
      'h',
      'e',
      'r',
      ' ',
    ])
    expect(lineKeys('teh ', 'the ')).toEqual(['\x7f', '\x7f', '\x7f', 'h', 'e', ' '])
    expect(lineKeys('ls', 'l')).toEqual(['\x7f'])
  })

  it('counts a character made of two code units as one key', () => {
    expect(lineKeys('ok \u{1F600}', 'ok ')).toEqual(['\x7f'])
    expect(lineKeys('ok ', 'ok \u{1F600}')).toEqual(['\u{1F600}'])
  })

  it('sends nothing when the line did not change', () => {
    expect(lineKeys('same', 'same')).toEqual([])
  })
})

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
})

describe('pressSequence', () => {
  it('sends Enter, Esc, Tab, Shift+Tab and arrows as xterm does', () => {
    expect(pressSequence(press('Enter'), false)).toBe('\r')
    expect(pressSequence(press('Escape'), false)).toBe('\x1b')
    expect(pressSequence(press('Tab'), false)).toBe('\t')
    expect(pressSequence(press('Tab', { shiftKey: true }), false)).toBe('\x1b[Z')
    expect(pressSequence(press('ArrowUp'), false)).toBe('\x1b[A')
    expect(pressSequence(press('ArrowLeft'), true)).toBe('\x1bOD')
    expect(pressSequence(press('PageDown'), false)).toBe('\x1b[6~')
  })

  it('turns Ctrl and Alt combos into control characters and Esc prefixes', () => {
    expect(pressSequence(press('c', { ctrlKey: true }), false)).toBe('\x03')
    expect(pressSequence(press('b', { altKey: true }), false)).toBe('\x1bb')
    expect(pressSequence(press('ArrowLeft', { ctrlKey: true }), false)).toBe('\x1b[1;5D')
  })

  it('adds the soft modifiers to a key with none of its own', () => {
    expect(pressSequence(press('ArrowRight'), false, CTRL)).toBe('\x1b[1;5C')
    expect(pressSequence(press('Enter'), false, ALT)).toBe('\x1b\r')
  })

  it('sends Esc CR, a new line in Claude Code, for Alt+Enter and Shift+Enter alone', () => {
    expect(pressSequence(press('Enter', { shiftKey: true }), false)).toBe('\x1b\r')
    expect(pressSequence(press('Enter', { altKey: true }), false)).toBe('\x1b\r')
    expect(pressSequence(press('Enter', { ctrlKey: true }), false)).toBe('\r')
    expect(pressSequence(press('Enter', { shiftKey: true, ctrlKey: true }), false)).toBe('\r')
    expect(pressSequence(press('Enter', { shiftKey: true }), false, CTRL)).toBe('\r')
  })

  it('leaves plain text and Meta combos to the field', () => {
    expect(pressSequence(press('a'), false)).toBeNull()
    expect(pressSequence(press('A', { shiftKey: true }), false)).toBeNull()
    expect(pressSequence(press('v', { metaKey: true }), false)).toBeNull()
    expect(pressSequence(press('Backspace'), false)).toBeNull()
  })
})

describe('splitLines', () => {
  it('splits text at each kind of line break, keeping the text after the last', () => {
    expect(splitLines('ls -la\n')).toEqual({ lines: ['ls -la'], rest: '' })
    expect(splitLines('one\r\ntwo\rthree')).toEqual({ lines: ['one', 'two'], rest: 'three' })
    expect(splitLines('\n')).toEqual({ lines: [''], rest: '' })
  })

  it('leaves text with no line break whole', () => {
    expect(splitLines('echo hi')).toEqual({ lines: [], rest: 'echo hi' })
  })
})

describe('newlineKeys', () => {
  const event = (type: string, mods: Partial<KeyPress> = {}, isComposing = false) => {
    const state = { prevented: false }
    const preventDefault = () => {
      state.prevented = true
    }
    return { state, event: { ...press('Enter', mods), type, isComposing, preventDefault } }
  }
  const terminal = () => {
    const sent: string[] = []
    return {
      sent,
      term: {
        input: (data: string) => {
          sent.push(data)
        },
      },
    }
  }

  it('sends Esc CR once on keydown of Shift+Enter and keeps every event of it from xterm', () => {
    const { sent, term } = terminal()
    const down = event('keydown', { shiftKey: true })
    expect(newlineKeys(term, down.event)).toBe(false)
    expect(down.state.prevented).toBe(true)
    expect(newlineKeys(term, event('keypress', { shiftKey: true }).event)).toBe(false)
    expect(newlineKeys(term, event('keyup', { shiftKey: true }).event)).toBe(false)
    expect(sent).toEqual(['\x1b\r'])
  })

  it('leaves Enter, Ctrl+Enter, Alt+Enter and a composing Shift+Enter to xterm', () => {
    const { sent, term } = terminal()
    expect(newlineKeys(term, event('keydown').event)).toBe(true)
    expect(newlineKeys(term, event('keydown', { ctrlKey: true }).event)).toBe(true)
    expect(newlineKeys(term, event('keydown', { altKey: true }).event)).toBe(true)
    expect(newlineKeys(term, event('keydown', { shiftKey: true, metaKey: true }).event)).toBe(true)
    expect(newlineKeys(term, event('keydown', { shiftKey: true }, true).event)).toBe(true)
    expect(sent).toEqual([])
  })
})
