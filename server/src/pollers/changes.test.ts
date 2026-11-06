import type { PollerItem } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { changeKind, describeChange, diffItems, type SeenItem } from './changes.js'

const item = (key: string, fingerprint: string, extra: Partial<PollerItem> = {}): PollerItem => ({
  key,
  title: `Item ${key}`,
  kind: '',
  url: null,
  body: '',
  fields: {},
  fingerprint,
  ...extra,
})

const seenOf = (...items: PollerItem[]): Map<string, SeenItem> =>
  new Map(
    items.map(({ key, fingerprint, kind, title, url, fields }) => [
      key,
      { key, fingerprint, kind, title, url, fields },
    ]),
  )

const OPTIONS = { baseline: false, detectGone: false, complete: true }

describe('diffItems', () => {
  it('reports nothing for the baseline run', () => {
    expect(diffItems(new Map(), [item('a', '1')], { ...OPTIONS, baseline: true })).toEqual([])
  })

  it('reports new keys and changed fingerprints, not unchanged ones', () => {
    const seen = seenOf(item('a', '1'), item('b', '1'))
    const changes = diffItems(seen, [item('a', '1'), item('b', '2'), item('c', '1')], OPTIONS)
    expect(changes.map((change) => [change.type, changeKind(change)])).toEqual([
      ['changed', 'changed'],
      ['new', 'new'],
    ])
  })

  it('reports missing keys as gone only when asked and when the run was complete', () => {
    const seen = seenOf(item('a', '1'), item('b', '1', { kind: 'issue' }))
    expect(diffItems(seen, [item('a', '1')], OPTIONS)).toEqual([])
    expect(diffItems(seen, [item('a', '1')], { ...OPTIONS, detectGone: true, complete: false })).toEqual([])
    const gone = diffItems(seen, [item('a', '1')], { ...OPTIONS, detectGone: true })
    expect(gone.map(changeKind)).toEqual(['issue.gone'])
  })

  it("names events by the item's kind", () => {
    const seen = seenOf(item('a', '1', { kind: 'deploy' }))
    const changes = diffItems(seen, [item('a', '2', { kind: 'deploy' }), item('b', '1', { kind: 'deploy' })], OPTIONS)
    expect(changes.map(changeKind)).toEqual(['deploy.changed', 'deploy'])
  })
})

describe('describeChange', () => {
  it('lists the fields a change touched', () => {
    const before = item('a', '1', { fields: { status: 'open', n: 1 } })
    const after = item('a', '2', { title: 'Renamed', fields: { status: 'closed', n: 1 }, url: 'https://x.test/a' })
    const [change] = diffItems(seenOf(before), [after], OPTIONS)
    expect(change && describeChange(change)).toEqual({
      title: 'Changed: Renamed',
      detail: 'title: Item a -> Renamed\nstatus: open -> closed',
      url: 'https://x.test/a',
    })
  })

  it('shows a new item with its body and fields, and a gone one by its last title', () => {
    const [created] = diffItems(new Map(), [item('a', '1', { body: 'Hi', fields: { n: 2 } })], OPTIONS)
    expect(created && describeChange(created)).toEqual({ title: 'Item a', detail: 'Hi\nn: 2', url: null })
    const [gone] = diffItems(seenOf(item('a', '1')), [], { ...OPTIONS, detectGone: true })
    expect(gone && describeChange(gone)).toEqual({ title: 'Gone: Item a', detail: 'No longer listed', url: null })
  })
})
