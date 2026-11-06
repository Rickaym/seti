import { describe, expect, it } from 'vitest'
import { osc52Text } from './terminal-osc52'

const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

describe('osc52Text', () => {
  it('decodes a write to the clipboard, with UTF-8 and any selection targets', () => {
    expect(osc52Text(`c;${encode('copied from tmux')}`)).toBe('copied from tmux')
    expect(osc52Text(`;${encode('no target')}`)).toBe('no target')
    const accented = `caf${String.fromCodePoint(0xe9, 0x20, 0x2192)} ok`
    expect(osc52Text(`pc;${encode(accented)}`)).toBe(accented)
    expect(osc52Text('c;aGk')).toBe('hi')
  })

  it('never answers a read request', () => {
    expect(osc52Text('c;?')).toBeNull()
    expect(osc52Text(';?')).toBeNull()
  })

  it('ignores empty and malformed payloads', () => {
    expect(osc52Text('')).toBeNull()
    expect(osc52Text(encode('no separator'))).toBeNull()
    expect(osc52Text('c;')).toBeNull()
    expect(osc52Text('c;not base64!')).toBeNull()
    expect(osc52Text('c;a=b=')).toBeNull()
    expect(osc52Text('c;a')).toBeNull()
    expect(osc52Text(`x;${encode('bad target')}`)).toBeNull()
    expect(osc52Text(`c;${btoa('\xff\xfe')}`), 'not UTF-8').toBeNull()
  })

  it('ignores a copy over 1 MiB and takes one at the cap', () => {
    const cap = 'a'.repeat(1024 * 1024)
    const over = `${cap}a`
    expect(osc52Text(`c;${btoa(cap)}`)).toBe(cap)
    expect(osc52Text(`c;${btoa(over)}`)).toBeNull()
    expect(osc52Text(`c;${'A'.repeat(2 * 1024 * 1024)}`)).toBeNull()
  })
})
