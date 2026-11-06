import type { CDPSession, Page } from '@playwright/test'

interface Editor {
  value: string
  caret: number
}

/** The focused field's text and caret, as the keyboard reads them back. */
async function editorOf(page: Page): Promise<Editor> {
  return page.evaluate(() => {
    const el = document.activeElement
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return { value: el.value, caret: el.selectionStart ?? el.value.length }
    }
    return { value: '', caret: 0 }
  })
}

/** The letters and digits right before the end of `text`, the word Gboard recomposes. */
function wordBefore(text: string): string {
  let start = text.length
  while (start > 0 && /[\p{L}\p{N}]/u.test(text.charAt(start - 1))) {
    start--
  }
  return text.slice(start)
}

/** A key press as Android Chrome reports keyboard input: keyCode 229 around the keyboard's edit. */
async function imeKey(cdp: CDPSession, edit?: () => Promise<unknown>): Promise<void> {
  const key = { key: 'Unidentified', code: '', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
  await edit?.()
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

/** A real key event, as Gboard sends for Enter and for Backspace on an empty field. */
async function hardKey(cdp: CDPSession, key: string, code: number, text?: string): Promise<void> {
  const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  if (text !== undefined) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base, text })
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/** How a keyboard sends Enter. */
type EnterKind = 'key' | 'text' | 'insertLineBreak' | 'insertParagraph'

/** A line break as the browser applies one: a cancelable beforeinput, then the newline. */
function breakLine(inputType: string): void {
  const el = document.activeElement
  if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) {
    return
  }
  const before = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true })
  if (el.dispatchEvent(before)) {
    const at = el.selectionStart ?? el.value.length
    el.setRangeText('\n', at, el.selectionEnd ?? at, 'end')
    el.dispatchEvent(new InputEvent('input', { inputType, bubbles: true }))
  }
}

/**
 * Gboard on Chrome for Android, driven over CDP so Chrome raises the real events: each letter is
 * a keyCode 229 press that sets the composing word, a space commits the word (or its correction)
 * and then types a space. Like Gboard, it remembers where it left the caret; when the page moved
 * the caret, it commits the word as it stands and recomposes the word touching the caret.
 */
export class Gboard {
  private before = ''
  private word = ''

  private readonly page: Page
  private readonly cdp: CDPSession

  constructor(page: Page, cdp: CDPSession) {
    this.page = page
    this.cdp = cdp
  }

  /** Types `text`: letters compose, a space commits; `fixes` maps a typed word to its correction. */
  async type(text: string, fixes: Record<string, string> = {}): Promise<void> {
    for (const char of text) {
      if (char === ' ') {
        await this.space(fixes[this.word])
      } else {
        await this.letter(char)
      }
    }
  }

  /** Grows the composing word by one letter. */
  async letter(char: string): Promise<void> {
    await this.compose(this.word + char)
  }

  /** Sets the composing word, as a letter, a swipe or dictation does. */
  async compose(text: string): Promise<void> {
    this.word = text
    await imeKey(this.cdp, async () =>
      this.cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }),
    )
    await this.resync()
  }

  /** Commits the composing word, as typed or as corrected, then types a space. */
  async space(correction?: string): Promise<void> {
    const word = correction ?? this.word
    if (this.word !== '') {
      await imeKey(this.cdp, async () => this.cdp.send('Input.insertText', { text: word }))
    }
    this.before += word
    this.word = ''
    await imeKey(this.cdp, async () => this.cdp.send('Input.insertText', { text: ' ' }))
    this.before += ' '
    await this.resync()
  }

  /** A swipe: the whole word composes at once, then commits with a space. */
  async swipe(word: string): Promise<void> {
    await this.compose(word)
    await this.space()
  }

  /** Dictation: the phrase composes as it is heard, revised along the way, then commits. */
  async dictate(hypotheses: string[]): Promise<void> {
    for (const heard of hypotheses) {
      await this.compose(heard)
    }
    await this.space()
  }

  /** Backspace: shortens the composing word, deletes before the caret, or sends the key itself. */
  async backspace(): Promise<void> {
    if (this.word !== '') {
      await this.compose(this.word.slice(0, -1))
      return
    }
    const { caret } = await editorOf(this.page)
    if (caret === 0) {
      await hardKey(this.cdp, 'Backspace', 8)
      return
    }
    this.before = this.before.slice(0, -1)
    await imeKey(this.cdp, async () =>
      this.page.evaluate(() => {
        const el = document.activeElement
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const at = el.selectionStart ?? el.value.length
          el.setRangeText('', Math.max(0, at - 1), at, 'end')
          el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }))
        }
      }),
    )
  }

  /**
   * Enter: the keyboard finishes the word, then sends Enter as an Enter key, as a newline it
   * commits as text, or as the line break or paragraph a multi-line field gets.
   */
  async enter(how: EnterKind = 'key'): Promise<void> {
    if (this.word !== '') {
      await this.cdp.send('Input.insertText', { text: this.word })
      this.before += this.word
      this.word = ''
    }
    if (how === 'key') {
      await hardKey(this.cdp, 'Enter', 13, '\r')
    } else if (how === 'text') {
      await imeKey(this.cdp, async () => this.cdp.send('Input.insertText', { text: '\n' }))
    } else {
      await imeKey(this.cdp, async () => this.page.evaluate(breakLine, how))
    }
    this.before = ''
    await this.resync()
  }

  /** Re-reads the field the way Gboard does after the caret moved without it. */
  private async resync(): Promise<void> {
    const { caret } = await editorOf(this.page)
    if (caret === this.before.length + this.word.length) {
      return
    }
    if (this.word !== '') {
      await this.cdp.send('Input.insertText', { text: this.word })
    }
    const after = await editorOf(this.page)
    const head = after.value.slice(0, after.caret)
    const touching = wordBefore(head)
    this.before = head.slice(0, head.length - touching.length)
    this.word = touching
    if (touching !== '') {
      await this.cdp.send('Input.imeSetComposition', {
        text: touching,
        selectionStart: touching.length,
        selectionEnd: touching.length,
        replacementStart: this.before.length,
        replacementEnd: after.caret,
      })
    }
  }
}
