/** What SETI stands for, decoded out of the header logo on hover. */
export const PHRASE = 'Swarms of Extra Tactical Individuals'

/** How long each noise glyph holds before the next one, in milliseconds. */
const TICK_MS = 70

/** Thin, even-weight marks so the scramble reads as a quiet readout rather than static. */
export const NOISE = ':-/.'

/** A word of the phrase: its capital is a letter of SETI, or it is a small connecting word. */
export type Token =
  { kind: 'word'; capital: string; tail: string; letter: number; at: number } | { kind: 'link'; text: string }

/** A tail letter: its own char, the noise mark shown over it while scrambling, and its state. */
export interface Glyph {
  char: string
  noise: string
  state: 'wait' | 'noise' | 'lock'
}

function tokenize(phrase: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  let letter = 0
  for (const text of phrase.split(' ')) {
    if (/^[A-Z]/.test(text)) {
      tokens.push({ kind: 'word', capital: text.slice(0, 1), tail: text.slice(1), letter, at })
      letter += 1
    } else {
      tokens.push({ kind: 'link', text })
    }
    at += text.length + 1
  }
  return tokens
}

export const TOKENS = tokenize(PHRASE)

const LOCK_START_MS = 170
const LOCK_STEP_MS = 14
const SCRAMBLE_MS = 120

/** When the letter at `position` in the phrase locks: one even sweep from left to right. */
const lockAt = (position: number) => LOCK_START_MS + position * LOCK_STEP_MS

/** Milliseconds after opening by which every letter has locked. */
export const SETTLE_MS = lockAt(PHRASE.length - 1)

/** The tail of the word at `at` as it reads `elapsed` ms after opening: hidden, noise, itself. */
export function decode(tail: string, at: number, elapsed: number): Glyph[] {
  return Array.from(tail, (char, index): Glyph => {
    const position = at + 1 + index
    const lock = lockAt(position)
    const tick = Math.floor(Math.min(elapsed, lock) / TICK_MS)
    const noise = NOISE.charAt((tick + position * 3) % NOISE.length)
    if (elapsed >= lock) {
      return { char, noise, state: 'lock' }
    }
    return { char, noise, state: elapsed >= lock - SCRAMBLE_MS ? 'noise' : 'wait' }
  })
}
