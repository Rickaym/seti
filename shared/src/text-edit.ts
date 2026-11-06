const isSpace = (c: string) => /\s/.test(c)
const isWordChar = (c: string) => /[\p{L}\p{N}_]/u.test(c)

/** Where Ctrl+Backspace stops: back over spaces, then over one run of word or punctuation chars. */
export function previousWordStart(text: string, caret: number): number {
  let i = Math.min(Math.max(caret, 0), text.length)
  while (i > 0 && isSpace(text.charAt(i - 1))) {
    i--
  }
  const word = isWordChar(text.charAt(i - 1))
  while (i > 0 && !isSpace(text.charAt(i - 1)) && isWordChar(text.charAt(i - 1)) === word) {
    i--
  }
  return i
}

/** Where Ctrl+Delete stops: forward over spaces, then over one run of word or punctuation chars. */
export function nextWordEnd(text: string, caret: number): number {
  let i = Math.min(Math.max(caret, 0), text.length)
  while (i < text.length && isSpace(text.charAt(i))) {
    i++
  }
  const word = isWordChar(text.charAt(i))
  while (i < text.length && !isSpace(text.charAt(i)) && isWordChar(text.charAt(i)) === word) {
    i++
  }
  return i
}
