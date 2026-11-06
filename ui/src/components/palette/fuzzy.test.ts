import { describe, expect, it } from 'vitest'
import { fuzzyMatch, matchFields } from './fuzzy'

const score = (query: string, text: string) => fuzzyMatch(query, text)?.score ?? -Infinity

describe('fuzzyMatch', () => {
  it('matches an ordered subsequence ignoring case and says where', () => {
    expect(fuzzyMatch('nag', 'New agent')?.positions).toEqual([0, 4, 5])
    expect(fuzzyMatch('NA', 'new agent')).not.toBeNull()
  })

  it('rejects missing or reordered characters and empty queries', () => {
    expect(fuzzyMatch('xyz', 'New agent')).toBeNull()
    expect(fuzzyMatch('ga', 'ag')).toBeNull()
    expect(fuzzyMatch('', 'New agent')).toBeNull()
    expect(fuzzyMatch('longer than', 'short')).toBeNull()
  })

  it('ranks an exact match above everything else', () => {
    expect(score('repos', 'Repos')).toBeGreaterThan(score('repos', 'Repos and more'))
  })

  it('prefers word starts and runs over scattered letters', () => {
    expect(score('na', 'New agent')).toBeGreaterThan(score('na', 'banana'))
    expect(score('set', 'Settings')).toBeGreaterThan(score('set', 'Sandbox extra tools'))
    expect(score('pr', 'Pull requests')).toBeGreaterThan(score('pr', 'Capture'))
    expect(score('fix', 'fix login')).toBeGreaterThan(score('fix', 'final index'))
  })

  it('places matches on word starts when it can', () => {
    expect(fuzzyMatch('ag', 'manage agents')?.positions).toEqual([7, 8])
    expect(fuzzyMatch('mcp', 'MCP servers')?.positions).toEqual([0, 1, 2])
    expect(fuzzyMatch('ss', 'Settings: SSH')?.positions).toEqual([10, 11])
  })

  it('prefers the shorter of two otherwise equal matches', () => {
    expect(score('agent', 'Agents')).toBeGreaterThan(score('agent', 'Agents and other long words'))
  })

  it('finds a scattered query across hundreds of long titles', () => {
    const titles = Array.from(
      { length: 800 },
      (_, i) => `Agent ${String(i)} fixing the login page of repo ${String(i)}`,
    )
    const hits = titles.filter((title) => fuzzyMatch('lgnpg', title) !== null)
    expect(hits).toHaveLength(800)
  })
})

describe('matchFields', () => {
  it('needs every term to match some field, in any order', () => {
    const fields = ['Fix the login page', 'Octocat/seti']
    expect(matchFields('login seti', fields)?.positions).toEqual([
      [8, 9, 10, 11, 12],
      [8, 9, 10, 11],
    ])
    expect(matchFields('seti login', fields)).not.toBeNull()
    expect(matchFields('login nowhere', fields)).toBeNull()
    expect(matchFields('   ', fields)).toBeNull()
  })

  it('scores a title match above the same match on the second line or in keywords', () => {
    const title = matchFields('ssh', ['SSH', 'Settings', ''])?.score ?? -Infinity
    const detail = matchFields('ssh', ['Hosts', 'SSH', ''])?.score ?? -Infinity
    const keyword = matchFields('ssh', ['Hosts', 'Settings', 'ssh'])?.score ?? -Infinity
    expect(title).toBeGreaterThan(detail)
    expect(detail).toBeGreaterThan(keyword)
  })

  it('ignores a term scattered across a long second line', () => {
    expect(matchFields('ssh', ['Seti guide', 'How Seti runs agents, their workspace'])).toBeNull()
    expect(matchFields('ssh', ['SSH hosts', 'How Seti runs agents, their workspace'])).not.toBeNull()
  })

  it('highlights nothing for a term found only in keywords', () => {
    expect(matchFields('pinned', ['Deploy bot', 'repo', 'pinned'])?.positions).toEqual([[], [], [0, 1, 2, 3, 4, 5]])
  })
})
