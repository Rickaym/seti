import { HIGHLIGHT_LINE_MAX } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { chunksOf, FILE_HIGHLIGHT_LINES, lineCount, piecesOf, plainReason } from './code-lines'

const lines = (count: number) => Array.from({ length: count }, (_, n) => `line ${String(n + 1)}`).join('\n')

describe('line chunks', () => {
  it('counts lines as an editor numbers them, a final newline ending the last one', () => {
    expect(lineCount('')).toBe(1)
    expect(lineCount('a')).toBe(1)
    expect(lineCount('a\n')).toBe(1)
    expect(lineCount('a\nb')).toBe(2)
    expect(lineCount('a\n\n')).toBe(2)
  })

  it('splits long text into chunks of whole lines that cover it all', () => {
    const text = `${lines(450)}\n`
    const chunks = chunksOf(text)
    expect(chunks.map((chunk) => [chunk.first, chunk.count])).toEqual([
      [1, 200],
      [201, 200],
      [401, 50],
    ])
    expect(chunks.map((chunk) => text.slice(chunk.from, chunk.to)).join('\n')).toBe(lines(450))
    const second = chunks[1] ?? { from: 0, to: 0 }
    expect(text.slice(second.from, second.to).split('\n')[0]).toBe('line 201')
  })

  it('splits a chunk around the marked line', () => {
    const text = lines(5)
    const [chunk] = chunksOf(text)
    if (chunk === undefined) {
      throw new Error('no chunk')
    }
    const pieces = piecesOf(text, chunk, 3)
    expect(pieces.map((piece) => [text.slice(piece.from, piece.to), piece.marked])).toEqual([
      ['line 1\nline 2\n', false],
      ['line 3', true],
      ['\nline 4\nline 5', false],
    ])
    expect(piecesOf(text, chunk, 1).map((piece) => piece.marked)).toEqual([true, false])
    expect(piecesOf(text, chunk, 5).map((piece) => piece.marked)).toEqual([false, true])
    expect(piecesOf(text, chunk, 9)).toEqual([{ from: chunk.from, to: chunk.to, marked: false }])
  })

  it('ends a chunk early once it holds many characters, never splitting a line', () => {
    const wide = Array.from({ length: 10 }, (_, n) => `${String(n)}${'x'.repeat(8_999)}`)
    const text = [...wide, lines(3)].join('\n')
    const chunks = chunksOf(text)
    expect(chunks.map((chunk) => [chunk.first, chunk.count])).toEqual([
      [1, 3],
      [4, 3],
      [7, 3],
      [10, 4],
    ])
    expect(chunks.map((chunk) => text.slice(chunk.from, chunk.to)).join('\n')).toBe(text)
    const long = `a\n${'y'.repeat(50_000)}\nb`
    expect(chunksOf(long).map((chunk) => [chunk.first, chunk.count])).toEqual([
      [1, 2],
      [3, 1],
    ])
  })

  it('leaves files over the line or size limit plain', () => {
    expect(plainReason(lines(100))).toBeNull()
    expect(plainReason(lines(FILE_HIGHLIGHT_LINES + 1))).toBe('size')
    expect(plainReason('x'.repeat(1_000_001))).toBe('size')
  })

  it('leaves a file with one line past the line cap plain', () => {
    const line = 'z'.repeat(HIGHLIGHT_LINE_MAX)
    expect(plainReason(`a\n${line}\nb`)).toBeNull()
    expect(plainReason(`${line}\n`)).toBeNull()
    expect(plainReason(`a\n${line}z\nb`)).toBe('long-line')
    expect(plainReason(`a\nb\n${line}z`)).toBe('long-line')
  })
})
