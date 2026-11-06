import { describe, expect, it } from 'vitest'
import { detectDelimiter, parseDelimited } from './csv'

describe('parseDelimited', () => {
  it('splits plain rows and ignores a trailing line break', () => {
    expect(parseDelimited('a,b,c\n1,2,3\n', ',')).toEqual({
      rows: [
        ['a', 'b', 'c'],
        ['1', '2', '3'],
      ],
      columns: 3,
      truncated: false,
    })
  })

  it('reads quoted fields with delimiters, doubled quotes and line breaks', () => {
    const text = 'name,note\r\n"Smith, J","said ""hi"""\r\n"multi\nline",x\r\n'
    expect(parseDelimited(text, ',').rows).toEqual([
      ['name', 'note'],
      ['Smith, J', 'said "hi"'],
      ['multi\nline', 'x'],
    ])
  })

  it('keeps empty fields, a trailing delimiter and ragged rows', () => {
    const parsed = parseDelimited('a,,c\n1\n2,3,4,5,', ',')
    expect(parsed.rows).toEqual([['a', '', 'c'], ['1'], ['2', '3', '4', '5', '']])
    expect(parsed.columns).toBe(5)
  })

  it('accepts CR line endings and strips a byte order mark', () => {
    expect(parseDelimited('\uFEFFa;b\r1;2', ';').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('treats an unterminated quote as running to the end', () => {
    expect(parseDelimited('a,"open\nstill', ',').rows).toEqual([['a', 'open\nstill']])
  })

  it('stops at whole rows once the cell cap is reached', () => {
    const parsed = parseDelimited('a,b\nc,d\ne,f\n', ',', { maxCells: 3 })
    expect(parsed.rows).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(parsed.truncated).toBe(true)
  })
})

describe('detectDelimiter', () => {
  it('picks the delimiter that splits every line the same way', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',')
    expect(detectDelimiter('a;b;c\n1,5;2,5;3\n')).toBe(';')
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t')
  })

  it('ignores delimiters inside quotes and a byte order mark', () => {
    expect(detectDelimiter('\uFEFF"x,y";z\n"1,2";3\n')).toBe(';')
  })

  it('falls back to a comma for a single column', () => {
    expect(detectDelimiter('one\ntwo\n')).toBe(',')
  })
})
