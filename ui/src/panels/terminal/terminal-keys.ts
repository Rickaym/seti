import type { Terminal } from '@xterm/xterm'

/** Keys a phone keyboard lacks that send a sequence rather than a character. */
const NAMED_KEYS = ['Esc', 'Tab', 'BackTab', 'Left', 'Up', 'Down', 'Right', 'Home', 'End', 'PgUp', 'PgDn'] as const
type NamedKey = (typeof NAMED_KEYS)[number]

/** Characters that hide on a second or third page of most phone keyboards. */
export const SYMBOL_KEYS = ['|', '~', '/', '-', '_', ':', ';'] as const

/** A soft key: a named key or one of the symbols. */
export type SoftKey = NamedKey | (typeof SYMBOL_KEYS)[number]

/** Ctrl and Alt as the next key gets them. */
export interface Held {
  ctrl: boolean
  alt: boolean
}

const NO_MODIFIERS: Held = { ctrl: false, alt: false }

const isNamed = (key: SoftKey): key is NamedKey => (NAMED_KEYS as readonly string[]).includes(key)

/** Final bytes of the cursor keys, which take SS3 in application cursor mode and CSI otherwise. */
const CURSOR: Partial<Record<NamedKey, string>> = { Up: 'A', Down: 'B', Right: 'C', Left: 'D', Home: 'H', End: 'F' }
const TILDE: Partial<Record<NamedKey, string>> = { PgUp: '5', PgDn: '6' }
const PLAIN: Partial<Record<NamedKey, string>> = { Esc: '\x1b', Tab: '\t', BackTab: '\x1b[Z' }

/** The xterm modifier parameter: 1 plus 2 for Alt and 4 for Ctrl. */
const modifierParam = ({ ctrl, alt }: Held) => 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0)

/** What a named key sends, as xterm encodes it; arrows follow the program's cursor key mode. */
function namedSequence(key: NamedKey, applicationCursor: boolean, held: Held): string {
  const modified = held.ctrl || held.alt
  const cursor = CURSOR[key]
  if (cursor !== undefined) {
    if (modified) {
      return `\x1b[1;${String(modifierParam(held))}${cursor}`
    }
    return `\x1b${applicationCursor ? 'O' : '['}${cursor}`
  }
  const tilde = TILDE[key]
  if (tilde !== undefined) {
    return modified ? `\x1b[${tilde};${String(modifierParam(held))}~` : `\x1b[${tilde}~`
  }
  const plain = PLAIN[key] ?? ''
  return held.alt ? `\x1b${plain}` : plain
}

/** Typed text with Ctrl held: a letter or one of @[\]^_ becomes its control character. */
export function withCtrl(data: string): string {
  if (data.length !== 1) {
    return data
  }
  if (data === ' ') {
    return '\x00'
  }
  if (data === '?') {
    return '\x7f'
  }
  const code = data.toUpperCase().charCodeAt(0)
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data
}

/** What Backspace sends. */
export const DEL = '\x7f'

/** True for text that is one character, the only text a held modifier applies to. */
export const isOneChar = (data: string) => data !== '' && Array.from(data).length === 1

/** One typed character as held modifiers change it: Ctrl makes a control code, Alt adds Esc. */
export function withModifiers(data: string, held: Held): string {
  if (!isOneChar(data)) {
    return data
  }
  // Backspace sends DEL, and xterm sends BS for it with Ctrl held.
  const ctrlChar = data === DEL ? '\b' : withCtrl(data)
  const ctrled = held.ctrl ? ctrlChar : data
  return held.alt ? `\x1b${ctrled}` : ctrled
}

/** What a soft key sends with the held modifiers. */
export function keySequence(key: SoftKey, applicationCursor: boolean, held: Held = NO_MODIFIERS): string {
  return isNamed(key) ? namedSequence(key, applicationCursor, held) : withModifiers(key, held)
}

/**
 * The keys that turn a shell line from `sent` into `typed`, with the cursor at its end: a
 * Backspace for each character after the point where they part, then the rest of `typed`.
 */
export function lineKeys(sent: string, typed: string): string[] {
  const before = Array.from(sent)
  const after = Array.from(typed)
  let same = 0
  while (same < before.length && same < after.length && before[same] === after[same]) {
    same++
  }
  return [...Array.from({ length: before.length - same }, () => DEL), ...after.slice(same)]
}

/** Text split at its line breaks: the lines each break ended, and the text after the last. */
export function splitLines(text: string): { lines: string[]; rest: string } {
  const lines = text.split(/\r\n|\r|\n/u)
  const rest = lines.pop() ?? ''
  return { lines, rest }
}

/** A key press as a keyboard event reports it. */
export interface KeyPress {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** Esc then Return, which Claude Code reads as a new line rather than a submit. */
const NEWLINE = '\x1b\r'

/** Shift+Enter with no other modifier, the key Claude Code's terminal setup binds to a new line. */
const isShiftEnter = (press: KeyPress): boolean =>
  press.key === 'Enter' && press.shiftKey && !press.ctrlKey && !press.altKey && !press.metaKey

const NAMED_BY_KEY: Partial<Record<string, NamedKey>> = {
  Escape: 'Esc',
  Tab: 'Tab',
  ArrowLeft: 'Left',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
}

/**
 * What a key press sends when it is not text for a field: Enter, Esc, Tab, arrows, paging keys
 * and Ctrl or Alt combos, with the soft modifiers added; Alt+Enter and Shift+Enter send a new
 * line. Null leaves the press to the field.
 */
export function pressSequence(press: KeyPress, applicationCursor: boolean, soft: Held = NO_MODIFIERS): string | null {
  if (press.metaKey) {
    return null
  }
  const held = { ctrl: soft.ctrl || press.ctrlKey, alt: soft.alt || press.altKey }
  if (press.key === 'Enter') {
    return held.alt || (isShiftEnter(press) && !held.ctrl) ? NEWLINE : '\r'
  }
  const named = press.key === 'Tab' && press.shiftKey ? 'BackTab' : NAMED_BY_KEY[press.key]
  if (named !== undefined) {
    return keySequence(named, applicationCursor, held)
  }
  return (press.ctrlKey || press.altKey) && isOneChar(press.key) ? withModifiers(press.key, held) : null
}

/** A keyboard event as xterm's key handler gets it, once for each of keydown, keypress and keyup. */
type KeyEvent = KeyPress & Pick<KeyboardEvent, 'type' | 'isComposing' | 'preventDefault'>

/**
 * Sends Shift+Enter as a new line, since xterm sends a plain Return for it and Alt+Enter never
 * reaches the page in some app windows. It returns false for each event of that press, so xterm
 * sends nothing more for it.
 */
export function newlineKeys(term: Pick<Terminal, 'input'>, event: KeyEvent): boolean {
  if (event.isComposing || !isShiftEnter(event)) {
    return true
  }
  if (event.type === 'keydown') {
    event.preventDefault()
    term.input(NEWLINE, true)
  }
  return false
}
