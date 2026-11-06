import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isSealed, parseKey, secretBox, TamperedError, WrongKeyError } from './secret-box.js'

const KEY = randomBytes(32)
const box = secretBox(KEY)
const VALUE = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'

/** Flips one base64url character of the part at `index` in a sealed value. */
function flip(sealed: string, index: number): string {
  const parts = sealed.split(':')
  const part = parts[index] ?? ''
  const swapped = part.startsWith('A') ? `B${part.slice(1)}` : `A${part.slice(1)}`
  return [...parts.slice(0, index), swapped, ...parts.slice(index + 1)].join(':')
}

describe('secret box', () => {
  it('opens what it sealed, with a fresh nonce each time', () => {
    const first = box.seal(VALUE, 'secret:github_agent_token')
    const second = box.seal(VALUE, 'secret:github_agent_token')
    expect(isSealed(first)).toBe(true)
    expect(first).not.toContain(VALUE)
    expect(first).not.toBe(second)
    expect(box.open(first, 'secret:github_agent_token')).toBe(VALUE)
    expect(box.open(second, 'secret:github_agent_token')).toBe(VALUE)
  })

  it('round-trips empty and non-ASCII text', () => {
    for (const text of ['', `caf${String.fromCodePoint(0xe9, 0x20, 0x1f511)}`, 'x'.repeat(5000)]) {
      expect(box.open(box.seal(text, 'c'), 'c')).toBe(text)
    }
  })

  it('names a wrong key instead of calling it tampering', () => {
    const sealed = box.seal(VALUE, 'c')
    const other = secretBox(randomBytes(32))
    expect(() => other.open(sealed, 'c')).toThrow(WrongKeyError)
  })

  it('refuses a value that was changed, truncated or moved to another name', () => {
    const sealed = box.seal(VALUE, 'secret:github_agent_token')
    expect(() => box.open(sealed, 'secret:claude_oauth_token')).toThrow(TamperedError)
    for (const index of [2, 3, 4]) {
      expect(() => box.open(flip(sealed, index), 'secret:github_agent_token')).toThrow(TamperedError)
    }
    expect(() => box.open(sealed.slice(0, -4), 'secret:github_agent_token')).toThrow(TamperedError)
    expect(() => box.open(`${sealed}:extra`, 'secret:github_agent_token')).toThrow(TamperedError)
    expect(() => box.open(VALUE, 'secret:github_agent_token')).toThrow(TamperedError)
  })

  it('takes only a 32 byte base64 key', () => {
    expect(parseKey(KEY.toString('base64'))).toEqual(KEY)
    expect(() => parseKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/)
    expect(() => secretBox(randomBytes(31))).toThrow(/32 bytes/)
  })
})
