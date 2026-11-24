/** A word read so far and where the text goes on, or null where the text breaks the word. */
type Step = { value: string; next: number } | null

/** Characters a POSIX shell keeps as they are outside quotes; anything else ends a plain word. */
const PLAIN = /[\w./=:,+@%^~-]/

/** Backslash escapes only these characters inside double quotes. */
const DOUBLE_ESCAPES = '"\\$`\n'

function singleQuoted(text: string, at: number): Step {
  const end = text.indexOf("'", at + 1)
  return end < 0 ? null : { value: text.slice(at + 1, end), next: end + 1 }
}

function doubleQuoted(text: string, at: number): Step {
  let value = ''
  let i = at + 1
  while (i < text.length) {
    const char = text.charAt(i)
    if (char === '"') {
      return { value, next: i + 1 }
    }
    const escaped = text.charAt(i + 1)
    if (char === '\\' && escaped !== '' && DOUBLE_ESCAPES.includes(escaped)) {
      value += escaped === '\n' ? '' : escaped
      i += 2
    } else {
      value += char
      i += 1
    }
  }
  return null
}

function unquoted(text: string, at: number): Step {
  const char = text.charAt(at)
  if (char === '\\') {
    const escaped = text.charAt(at + 1)
    return escaped === '' ? null : { value: escaped === '\n' ? '' : escaped, next: at + 2 }
  }
  return PLAIN.test(char) ? { value: char, next: at + 1 } : null
}

const READERS: Record<string, (text: string, at: number) => Step> = { "'": singleQuoted, '"': doubleQuoted }

/**
 * The value of text that is exactly one POSIX shell word, as a shell reads it: single-quoted,
 * double-quoted and plain parts joined; null for anything else, such as two words.
 */
export function shellWord(text: string): string | null {
  let value = ''
  let at = 0
  while (at < text.length) {
    const step = (READERS[text.charAt(at)] ?? unquoted)(text, at)
    if (step === null) {
      return null
    }
    value += step.value
    at = step.next
  }
  return text === '' ? null : value
}
