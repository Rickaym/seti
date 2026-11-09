/** How long the first key of `gg`, `gf` or `Ctrl+\ n` waits for the second. */
export const SEQUENCE_MS = 800

/** What a key asks of the active panel or the app; none of them destroys anything. */
export type VimAction =
  | { type: 'scroll'; by: 'line' | 'half'; direction: 1 | -1 }
  | { type: 'edge'; to: 'top' | 'bottom' }
  | { type: 'panel'; to: 'previous' | 'next' | 'first' | 'last' | 'up' | 'down' }
  | { type: 'panelAt'; index: number }
  | { type: 'insert'; at: 'keep' | 'end' }
  | { type: 'find' }
  | { type: 'findStep'; direction: 'next' | 'previous' }
  | { type: 'help' }
  | { type: 'palette' }
  | { type: 'files' }
  | { type: 'groupChat' }
  /** Esc in a field: leave it for the panel, which is normal mode. */
  | { type: 'normal' }
  /** Esc in normal mode while the active panel's find bar is open. */
  | { type: 'closeFind' }

/** Where focus sits and what is open when a key arrives. */
export interface KeyContext {
  enabled: boolean
  /** Focus is in a field or widget that takes typed keys. */
  typing: boolean
  /** Focus is in a terminal, frame or media player, which takes every key untouched. */
  passthrough: boolean
  /** The key comes from a terminal, which lends Vim mode only `Ctrl+\ n` to leave it. */
  terminal: boolean
  /** A dialog, popover or menu is open and owns the keys. */
  overlay: boolean
  /** The active panel's find bar is open. */
  finding: boolean
}

export type KeyStroke = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'isComposing'>

/** The first key of a sequence and when it came. */
export interface Pending {
  key: 'g' | 'Ctrl+\\'
  at: number
}

export interface KeyResult {
  action: VimAction | null
  /** The key belongs to Vim mode, so the page and browser must not see it. */
  handled: boolean
  pending: Pending | null
}

const PASS: KeyResult = { action: null, handled: false, pending: null }

const act = (action: VimAction): KeyResult => ({ action, handled: true, pending: null })

const SINGLE: Record<string, VimAction> = {
  j: { type: 'scroll', by: 'line', direction: 1 },
  k: { type: 'scroll', by: 'line', direction: -1 },
  G: { type: 'edge', to: 'bottom' },
  h: { type: 'panel', to: 'previous' },
  l: { type: 'panel', to: 'next' },
  H: { type: 'panel', to: 'first' },
  L: { type: 'panel', to: 'last' },
  J: { type: 'panel', to: 'down' },
  K: { type: 'panel', to: 'up' },
  i: { type: 'insert', at: 'keep' },
  a: { type: 'insert', at: 'end' },
  '/': { type: 'find' },
  n: { type: 'findStep', direction: 'next' },
  N: { type: 'findStep', direction: 'previous' },
  '?': { type: 'help' },
  ':': { type: 'palette' },
}

const AFTER_G: Record<string, VimAction> = {
  g: { type: 'edge', to: 'top' },
  f: { type: 'files' },
  c: { type: 'groupChat' },
}

const CTRL: Record<string, VimAction> = {
  d: { type: 'scroll', by: 'half', direction: 1 },
  u: { type: 'scroll', by: 'half', direction: -1 },
}

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta'])

/** Ctrl+\ waits for n or Ctrl+n to leave the terminal; any other second key goes to the shell. */
function terminalKey(stroke: KeyStroke, pending: Pending | null, now: number): KeyResult {
  if (MODIFIERS.has(stroke.key)) {
    return { action: null, handled: false, pending }
  }
  if (stroke.altKey || stroke.metaKey) {
    return PASS
  }
  if (pending?.key === 'Ctrl+\\' && now - pending.at <= SEQUENCE_MS) {
    return stroke.key === 'n' ? act({ type: 'normal' }) : PASS
  }
  return stroke.ctrlKey && stroke.key === '\\'
    ? { action: null, handled: true, pending: { key: 'Ctrl+\\', at: now } }
    : PASS
}

function escape(context: KeyContext): KeyResult {
  if (context.typing) {
    return act({ type: 'normal' })
  }
  return context.finding ? act({ type: 'closeFind' }) : PASS
}

function plainKey(key: string): KeyResult {
  if (key === 'g') {
    return { action: null, handled: true, pending: null }
  }
  if (/^[1-9]$/u.test(key)) {
    return act({ type: 'panelAt', index: Number(key) - 1 })
  }
  const action = SINGLE[key]
  return action === undefined ? PASS : act(action)
}

/** Esc, Ctrl and Meta keys, and every key while typing; null leaves the key to the plain reader. */
function modifiedKey(stroke: KeyStroke, context: KeyContext): KeyResult | null {
  if (stroke.key === 'Escape') {
    return stroke.ctrlKey || stroke.metaKey ? PASS : escape(context)
  }
  if (context.typing || stroke.metaKey) {
    return PASS
  }
  if (stroke.ctrlKey) {
    const action = CTRL[stroke.key]
    return action === undefined ? PASS : act(action)
  }
  return null
}

/**
 * Turns one key press into a Vim mode action. Keys act only in normal mode: Vim mode on, focus
 * outside fields, terminals and frames, and no dialog or menu open. Esc in a field and `Ctrl+\ n`
 * in a terminal leave insert mode. A `g` waits `SEQUENCE_MS` for its second key; any other key
 * then acts as itself.
 */
export function readKey(stroke: KeyStroke, context: KeyContext, pending: Pending | null, now: number): KeyResult {
  if (!context.enabled || context.overlay || stroke.isComposing) {
    return PASS
  }
  if (context.terminal) {
    return terminalKey(stroke, pending, now)
  }
  if (context.passthrough || stroke.altKey) {
    return PASS
  }
  const modified = modifiedKey(stroke, context)
  if (modified !== null) {
    return modified
  }
  const second = pending?.key === 'g' && now - pending.at <= SEQUENCE_MS ? AFTER_G[stroke.key] : undefined
  if (second !== undefined) {
    return act(second)
  }
  const result = plainKey(stroke.key)
  return stroke.key === 'g' ? { ...result, pending: { key: 'g', at: now } } : result
}

/** One row of the cheat sheet. */
interface Binding {
  keys: string
  action: string
}

/** Every binding, grouped as the cheat sheet shows them. */
export const BINDINGS: readonly { heading: string; rows: readonly Binding[] }[] = [
  {
    heading: 'Modes',
    rows: [
      { keys: 'Esc', action: 'Leave a field for the panel (normal mode)' },
      { keys: 'Ctrl+\\ n', action: 'Leave a terminal for its panel' },
      { keys: 'i', action: 'Write in the panel or its terminal (insert mode)' },
      { keys: 'a', action: 'Write at the end of the draft' },
    ],
  },
  {
    heading: 'Scroll',
    rows: [
      { keys: 'j / k', action: 'Down / up a little' },
      { keys: 'Ctrl+d / Ctrl+u', action: 'Down / up half a page' },
      { keys: 'gg / G', action: 'Top / bottom, following new messages' },
    ],
  },
  {
    heading: 'Panels',
    rows: [
      { keys: 'h / l', action: 'Previous / next panel' },
      { keys: 'K / J', action: 'Panel above / below' },
      { keys: 'H / L', action: 'First / last panel' },
      { keys: '1-9', action: 'Panel by position' },
    ],
  },
  {
    heading: 'Find',
    rows: [
      { keys: '/', action: 'Find in the panel' },
      { keys: 'Enter', action: 'Back to normal mode at the match' },
      { keys: 'n / N', action: 'Older / newer match' },
      { keys: 'Esc', action: 'Close find' },
    ],
  },
  {
    heading: 'More',
    rows: [
      { keys: ':', action: 'Command palette' },
      { keys: 'gf', action: 'Files of the agent' },
      { keys: 'gc', action: 'Group chat' },
      { keys: '?', action: 'This list' },
    ],
  },
]
