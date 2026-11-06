import { Bot } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { browse, RECENT_HEADING, search, type EntryGroup, type PaletteEntry } from './rank'

const entry = (id: string, group: string, title: string, detail = ''): PaletteEntry => ({
  id,
  group,
  title,
  detail,
  icon: Bot,
  run: () => undefined,
})

const ENTRIES = [
  entry('section:agents', 'Sections', 'Agents'),
  entry('section:prs', 'Sections', 'Pull requests'),
  entry('agent:1', 'Agents', 'Fix login page', 'Octocat/seti'),
  entry('agent:2', 'Agents', 'Deploy bot', 'Octocat/infra'),
  entry('agent:3', 'Agents', 'Agent palette', 'Octocat/seti'),
  entry('settings:repos', 'Settings', 'Repos', 'Settings, Seti'),
]

const shape = (groups: EntryGroup[]) => groups.map((g) => [g.heading, g.items.map((i) => i.entry.id)])

describe('browse', () => {
  it('lists recent entries first, in recent order, and leaves them out of their groups', () => {
    const groups = browse(ENTRIES, ['agent:2', 'gone', 'section:prs'], { cap: 10 })
    expect(shape(groups)).toEqual([
      [RECENT_HEADING, ['agent:2', 'section:prs']],
      ['Sections', ['section:agents']],
      ['Agents', ['agent:1', 'agent:3']],
      ['Settings', ['settings:repos']],
    ])
  })

  it('shows only the asked groups and caps each one, while recents come from any group', () => {
    const groups = browse(ENTRIES, ['settings:repos'], { cap: 1, groups: ['Sections', 'Agents'] })
    expect(shape(groups)).toEqual([
      [RECENT_HEADING, ['settings:repos']],
      ['Sections', ['section:agents']],
      ['Agents', ['agent:1']],
    ])
  })
})

describe('search', () => {
  it('keeps matches only, best first, with groups in the order of their best match', () => {
    const groups = search('repos', ENTRIES, [], 10)
    expect(shape(groups)[0]).toEqual(['Settings', ['settings:repos']])
    expect(shape(search('agent', ENTRIES, [], 10))).toEqual([
      ['Sections', ['section:agents']],
      ['Agents', ['agent:3']],
    ])
  })

  it('matches the second line and marks where', () => {
    const [group] = search('infra', ENTRIES, [], 10)
    expect(group?.items[0]?.entry.id).toBe('agent:2')
    expect(group?.items[0]?.title).toEqual([])
    expect(group?.items[0]?.detail).toEqual([8, 9, 10, 11, 12])
  })

  it('lets a recent entry win a tie', () => {
    const twins = [entry('a', 'Agents', 'Same title'), entry('b', 'Agents', 'Same title')]
    expect(search('same', twins, [], 10)[0]?.items.map((i) => i.entry.id)).toEqual(['a', 'b'])
    expect(search('same', twins, ['b'], 10)[0]?.items.map((i) => i.entry.id)).toEqual(['b', 'a'])
  })

  it('keeps at most the limit', () => {
    const many = Array.from({ length: 300 }, (_, i) => entry(`agent:${String(i)}`, 'Agents', `Agent ${String(i)}`))
    const rows = search('agent', many, [], 50).flatMap((g) => g.items)
    expect(rows).toHaveLength(50)
  })
})
