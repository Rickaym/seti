import { diffPatch, modifiedPaths } from '@seti/shared'
import { describe, expect, it } from 'vitest'

describe('what differs from the defaults', () => {
  it('recurses into objects and carries arrays and scalars whole', () => {
    const defaults = { a: { b: 1, c: [1, 2] }, d: null }
    expect(diffPatch(defaults, defaults)).toBeUndefined()
    expect(diffPatch(defaults, { a: { b: 2, c: [1, 2] }, d: null })).toEqual({ a: { b: 2 } })
    expect(diffPatch(defaults, { a: { b: 1, c: [2] }, d: 'x' })).toEqual({ a: { c: [2] }, d: 'x' })
  })

  it('reads a key the document lacks as null, and keeps keys with dots as one step', () => {
    const defaults = { servers: { 'claude.ai Gmail': true, local: true } }
    const doc = { servers: { 'claude.ai Gmail': false, 'new.one': {} } }
    expect(diffPatch(defaults, doc)).toEqual({ servers: { 'claude.ai Gmail': false, 'new.one': {}, local: null } })
    expect(modifiedPaths(doc, defaults)).toEqual([
      ['servers', 'claude.ai Gmail'],
      ['servers', 'new.one'],
      ['servers', 'local'],
    ])
  })
})
