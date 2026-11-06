import type { ChangelogEntry } from '@seti/mod-api'
import { describe, expect, it } from 'vitest'
import { changelogDays, typeLabel } from './changelog-days'

const entry = (commit: string, date: string, notable: boolean): ChangelogEntry => ({
  commit,
  date,
  type: notable ? 'feat' : 'chore',
  scope: null,
  breaking: false,
  description: commit,
  pr: null,
  body: '',
  notable,
  current: false,
  unseen: false,
})

const NOW = new Date(2026, 9, 15, 18, 0)
const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).toISOString()

describe('changelogDays', () => {
  const entries = [
    entry('a', at(15, 10), true),
    entry('b', at(15, 9), false),
    entry('c', at(14, 23), true),
    entry('d', at(9, 12), true),
  ]

  it('groups notable entries by local day, newest first', () => {
    const days = changelogDays(entries, false, NOW)
    expect(days.map((day) => [day.label, day.entries.map((e) => e.commit)])).toEqual([
      ['Today', ['a']],
      ['Yesterday', ['c']],
      [new Date(2026, 9, 9).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), ['d']],
    ])
  })

  it('keeps upkeep when all entries are shown', () => {
    expect(changelogDays(entries, true, NOW)[0]?.entries.map((e) => e.commit)).toEqual(['a', 'b'])
  })

  it('names conventional types and falls back to the raw one', () => {
    expect([typeLabel('feat'), typeLabel('perf'), typeLabel('wip'), typeLabel(null)]).toEqual([
      'Feature',
      'Perf',
      'wip',
      'Other',
    ])
  })
})
