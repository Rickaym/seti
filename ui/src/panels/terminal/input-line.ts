import { DEL, lineKeys, pressSequence, splitLines, withModifiers, type Held } from './terminal-keys'
import { keepKeys, leavesTerminal } from './terminal-shortcut'

/** What the input line needs from the terminal it types into. */
export interface LineTarget {
  send: (data: string) => void
  /** Pastes as the terminal does, bracketed when the program asks for it. */
  paste: (text: string) => void
  /** The soft Ctrl and Alt the next key takes. */
  held: () => Held
  /** Turns the soft modifiers off once a key took them. */
  release: () => void
  applicationCursor: () => boolean
}

/** The input line as the terminal's key row and focus use it. */
export interface InputLine {
  /** Sends what the line still holds and empties it, before a key from elsewhere goes out. */
  settle: () => void
  teardown: () => void
}

/** What phone keyboards report as the key of a press that edits text through the IME. */
const IME_KEYS = new Set(['Unidentified', 'Process'])

const anyHeld = ({ ctrl, alt }: Held) => ctrl || alt

/** Input types a keyboard sends for Enter in a field that takes more than one line. */
const LINE_BREAKS = new Set(['insertLineBreak', 'insertParagraph'])

/**
 * Types into the shell from an ordinary text field, so a phone keyboard edits text it can see.
 * The shell's line mirrors the field: each committed change goes out as Backspaces back to where
 * the two part, then the new text, so a correction, a suggestion, a swipe or dictation reaches
 * the shell once and in order. A word still being composed waits for its commit, unless a soft
 * Ctrl or Alt was on for one of its letters: that word goes out letter by letter, the letter
 * typed takes the modifier, and the field empties once the word ends. The field is emptied only
 * between keyboard edits, never inside one, so the keyboard and the field agree on its text.
 * Enter goes out as Return however the keyboard sends it: as a key, as a line break, or as a
 * newline in the text, which never stays in the field.
 */
export function bindInputLine(field: HTMLTextAreaElement, target: LineTarget): InputLine {
  let sent = ''
  let composing = false
  /** The composition goes out as it changes, since a modifier took one of its letters. */
  let live = false
  /** The field holds text the shell got as a control key, so it must empty once it can. */
  let stale = false

  /** Sends what changed since the last sync; with `typed`, the last key takes the modifiers. */
  const sync = (typed: boolean) => {
    const keys = lineKeys(sent, field.value)
    sent = field.value
    const last = keys.length - 1
    const held = target.held()
    if (last < 0) {
      return
    }
    if (typed && anyHeld(held)) {
      keys[last] = withModifiers(keys[last] ?? '', held)
      target.release()
      stale = true
      live = composing
    }
    target.send(keys.join(''))
  }
  const clear = () => {
    field.setRangeText('', 0, field.value.length)
    sent = ''
    composing = false
    live = false
    stale = false
  }
  const clearWhenSettled = () => {
    window.setTimeout(() => {
      if (stale && !composing) {
        clear()
      }
    }, 0)
  }

  /** Sends each line a typed line break ended, with Return, and keeps the text after the last. */
  const breakLines = () => {
    const { lines, rest } = splitLines(field.value)
    for (const line of lines) {
      const keys = lineKeys(sent, line).join('')
      if (keys !== '') {
        target.send(keys)
      }
      target.release()
      target.send('\r')
      sent = ''
    }
    clear()
    field.setRangeText(rest, 0, 0, 'end')
    sync(false)
  }

  const onStart = () => {
    composing = true
    live = false
  }
  const onEnd = () => {
    composing = false
    live = false
    sync(false)
    if (stale) {
      clearWhenSettled()
    }
  }
  const onInput = (event: Event) => {
    if (/[\r\n]/u.test(field.value)) {
      breakLines()
      return
    }
    const inComposition = composing || (event instanceof InputEvent && event.isComposing)
    if (inComposition && !live && !anyHeld(target.held())) {
      return
    }
    sync(true)
    if (stale && !inComposition) {
      clearWhenSettled()
    }
  }
  const onKeyDown = (event: KeyboardEvent) => {
    keepKeys(event)
    if (event.isComposing || IME_KEYS.has(event.key) || leavesTerminal(event)) {
      return
    }
    const held = target.held()
    const data =
      event.key === 'Backspace' && field.value === ''
        ? withModifiers(DEL, { ctrl: held.ctrl || event.ctrlKey, alt: held.alt || event.altKey })
        : pressSequence(event, target.applicationCursor(), held)
    if (data === null) {
      return
    }
    event.preventDefault()
    sync(false)
    target.release()
    target.send(data)
    clear()
  }
  const onBeforeInput = (event: InputEvent) => {
    if (LINE_BREAKS.has(event.inputType)) {
      event.preventDefault()
      sync(false)
      target.release()
      target.send('\r')
      clear()
    }
  }
  const onPaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain') ?? ''
    event.preventDefault()
    sync(false)
    target.paste(text)
    clear()
  }

  field.addEventListener('compositionstart', onStart)
  field.addEventListener('compositionend', onEnd)
  field.addEventListener('beforeinput', onBeforeInput)
  field.addEventListener('input', onInput)
  field.addEventListener('keydown', onKeyDown)
  field.addEventListener('paste', onPaste)
  return {
    settle: () => {
      sync(false)
      clear()
    },
    teardown: () => {
      field.removeEventListener('compositionstart', onStart)
      field.removeEventListener('compositionend', onEnd)
      field.removeEventListener('beforeinput', onBeforeInput)
      field.removeEventListener('input', onInput)
      field.removeEventListener('keydown', onKeyDown)
      field.removeEventListener('paste', onPaste)
    },
  }
}
