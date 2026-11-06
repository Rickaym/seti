import { describe, expect, it } from 'vitest'
import { isFindShortcut } from '@/components/shortcuts/find'
import { findCount } from '@/hooks/useChatFind'
import { findPattern } from '@/hooks/useFindMarks'

const matches = (pattern: RegExp | null, text: string) => [...text.matchAll(pattern ?? /$^/gu)].map((m) => m[0])

describe('find pattern', () => {
  it('matches the text in any case, across folded whitespace, with symbols taken literally', () => {
    const pattern = findPattern('pnpm  check (all)', 'text')
    expect(matches(pattern, 'Run PNPM check\n(all) then pnpm check (all)')).toEqual([
      'PNPM check\n(all)',
      'pnpm check (all)',
    ])
    expect(matches(findPattern('a.b*', 'text'), 'axb a.b* a.bb')).toEqual(['a.b*'])
  })

  it('matches whole words only in words mode', () => {
    expect(
      matches(findPattern('deploy server', 'words'), 'Deploy the servers, then deploy server_x and SERVER'),
    ).toEqual(['Deploy', 'deploy', 'SERVER'])
    expect(findPattern('!!', 'words')).toBeNull()
    expect(findPattern('  ', 'text')).toBeNull()
  })
})

describe('find count', () => {
  const base = { query: 'deploy', hits: [], hasMore: false, index: -1, searching: false }

  it('reads the position among the hits, with a plus while more exist', () => {
    const hits = [
      { id: 9, kind: 'prompt', created_at: '', snippet: '' },
      { id: 4, kind: 'prompt', created_at: '', snippet: '' },
    ]
    expect(findCount({ ...base, hits, index: 1 })).toBe('2 of 2')
    expect(findCount({ ...base, hits, index: 0, hasMore: true })).toBe('1 of 2+')
  })

  it('stays quiet for a short query and says when nothing matched', () => {
    expect(findCount({ ...base, query: 'd' })).toBe('')
    expect(findCount({ ...base, searching: true })).toBe('...')
    expect(findCount(base)).toBe('No matches')
  })
})

describe('find shortcut', () => {
  const stroke = { key: 'f', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }

  it('is Ctrl+F, or Cmd+F on Apple devices', () => {
    expect(isFindShortcut({ ...stroke, ctrlKey: true }, false)).toBe(true)
    expect(isFindShortcut({ ...stroke, key: 'F', ctrlKey: true }, false)).toBe(true)
    expect(isFindShortcut({ ...stroke, metaKey: true }, false)).toBe(false)
    expect(isFindShortcut({ ...stroke, metaKey: true }, true)).toBe(true)
    expect(isFindShortcut({ ...stroke, ctrlKey: true, shiftKey: true }, false)).toBe(false)
    expect(isFindShortcut({ ...stroke, ctrlKey: true, altKey: true }, false)).toBe(false)
  })
})
