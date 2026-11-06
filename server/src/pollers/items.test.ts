import { POLLER_LIMITS } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { canonicalJson, readOutput } from './items.js'

describe('readOutput', () => {
  it('reads items with defaults, a state, and the fields an event shows', () => {
    const output = readOutput(
      {
        items: [
          {
            key: 42,
            title: ' Build failed ',
            kind: 'Build Status',
            url: 'https://ci.test/42',
            summary: 'Step test',
            fields: { status: 'red', nested: { deep: true } },
          },
          { key: 'b', url: 'javascript:alert(1)' },
        ],
        state: { cursor: 'c1' },
      },
      [],
    )
    expect(output).toMatchObject({
      complete: true,
      invalid: [],
      state: { cursor: 'c1' },
      items: [
        {
          key: '42',
          title: 'Build failed',
          kind: 'build_status',
          url: 'https://ci.test/42',
          body: 'Step test',
          fields: { status: 'red' },
        },
        { key: 'b', title: 'b', kind: '', url: null, body: '', fields: {} },
      ],
    })
  })

  it('reports unusable items without failing the run, and marks the run incomplete', () => {
    const output = readOutput([{ key: 'a' }, 'text', { title: 'no key' }, { key: 'a' }, { key: 'x'.repeat(201) }], [])
    expect(output).toMatchObject({
      items: [{ key: 'a' }],
      complete: false,
      invalid: [
        'Item 2: not an object',
        'Item 3: no key',
        'Item 4: the key a came twice',
        'Item 5: key over 200 characters',
      ],
    })
  })

  it('refuses output that is not a list, and a state over its limit', () => {
    expect(readOutput({ nope: true }, [])).toEqual({
      error: 'poll() must return an array of items, or { items, state }',
    })
    const state = { blob: 'x'.repeat(POLLER_LIMITS.stateMaxBytes) }
    expect(readOutput({ items: [], state }, [])).toEqual({ error: 'The state is over 16 KB' })
  })

  it('keeps the first items up to the limit and says how many it left out', () => {
    const many = Array.from({ length: POLLER_LIMITS.maxItems + 7 }, (_, i) => ({ key: String(i) }))
    const output = readOutput(many, [])
    expect(output).toMatchObject({ complete: false, invalid: ['7 items over the limit of 500 were left out'] })
    expect('items' in output && output.items.length).toBe(POLLER_LIMITS.maxItems)
  })

  it('fingerprints the whole item, the chosen fields, or what the script gave', () => {
    const read = (items: unknown[], fields: string[] = []) => {
      const output = readOutput(items, fields)
      return 'items' in output ? output.items.map((item) => item.fingerprint) : []
    }
    const [a, b] = read([
      { key: '1', title: 'x', fields: { n: 1, seen: 'now' } },
      { key: '2', title: 'x', fields: { seen: 'now', n: 1 } },
    ])
    expect(a).toBe(b)
    const [c, d] = read(
      [
        { key: '1', title: 'x', fields: { status: 'open', seen: 'now' } },
        { key: '2', title: 'y', fields: { status: 'open', seen: 'later' } },
      ],
      ['status'],
    )
    expect(c).toBe(d)
    expect(read([{ key: '1', fingerprint: 'v7' }])).toEqual(['v7'])
  })
})

describe('canonicalJson', () => {
  it('sorts keys at every depth', () => {
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}')
  })
})
