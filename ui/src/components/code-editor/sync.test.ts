import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { changeBetween, clampCaret, createEchoes, fromValue, isOwnEdit } from './sync'

const apply = (from: string, to: string) => {
  const state = EditorState.create({ doc: from })
  const changes = changeBetween(from, to)
  return changes === null ? state : state.update({ changes }).state
}

describe('changeBetween', () => {
  it('returns null when the texts match', () => {
    expect(changeBetween('const a = 1', 'const a = 1')).toBeNull()
  })

  it.each([
    ['const a = 1', 'const a = 12'],
    ['const a = 1', 'let a = 1'],
    ['abc', ''],
    ['', 'export default () => []'],
    ['aaaa', 'aa'],
    ['line one\nline two', 'line one\nline 2\nline three'],
  ])('turns %j into %j', (from, to) => {
    expect(apply(from, to).doc.toString()).toBe(to)
  })

  it('touches only the changed span, so a caret elsewhere stays put', () => {
    const doc = 'const a = 1\nconst b = 2\n'
    const state = EditorState.create({ doc, selection: { anchor: doc.length } })
    const changes = changeBetween(doc, 'const a = 10\nconst b = 2\n')
    expect(changes).toEqual({ from: 11, to: 11, insert: '0' })
    expect(state.update({ changes: changes ?? [] }).state.selection.main.head).toBe(doc.length + 1)
  })
})

describe('isOwnEdit', () => {
  const state = EditorState.create({ doc: 'a' })

  it('reports typing in the editor', () => {
    expect(isOwnEdit(state.update({ changes: { from: 1, insert: 'b' } }))).toBe(true)
  })

  it('skips edits that follow the value prop and moves that change nothing', () => {
    expect(isOwnEdit(state.update({ changes: { from: 1, insert: 'b' }, annotations: fromValue.of(true) }))).toBe(false)
    expect(isOwnEdit(state.update({ selection: { anchor: 0 } }))).toBe(false)
  })
})

describe('createEchoes', () => {
  it('treats reported texts as echoes, stale ones included, and others as outside changes', () => {
    const echoes = createEchoes()
    echoes.sent('a')
    echoes.sent('ab')
    echoes.sent('abc')
    expect(echoes.isEcho('a')).toBe(true)
    expect(echoes.isEcho('abc')).toBe(true)
    expect(echoes.isEcho('ab')).toBe(false)
    echoes.sent('abcd')
    expect(echoes.isEcho('preset')).toBe(false)
    expect(echoes.isEcho('abcd')).toBe(false)
  })
})

describe('clampCaret', () => {
  it('keeps a caret inside the document', () => {
    expect(clampCaret({ anchor: 2, head: 9 }, 5)).toEqual({ anchor: 2, head: 5 })
  })
})
