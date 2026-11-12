import {
  listedSubtasks,
  normalizeAgentColor,
  prStates,
  type ContextPack,
  type PrList,
  type PullRequest,
  type TaskListEntry,
} from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { agentPlaces, contextPlaces, prPlaces, sectionPlaces, settingsPlaces } from './places'

function task(id: string, extra: Partial<TaskListEntry> = {}): TaskListEntry {
  return {
    id,
    title: `Agent ${id}`,
    repo_id: null,
    repo_slug: null,
    repos: [],
    dirs: [],
    cwd: `/work/${id}`,
    worktree: false,
    sandbox: true,
    profile_id: 'default',
    seti_control: 'self',
    bypass_until: null,
    pr_urls: [],
    input_mode: 'off',
    session_id: null,
    source_session_id: null,
    status: 'idle',
    permission_mode: null,
    model: null,
    cost_usd: 0,
    outward_count: 0,
    last_error: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    archived_at: null,
    pinned: false,
    color: null,
    setup: null,
    warm_caches: [],
    workspace_id: 'w1',
    notifications_muted: false,
    status_line: null,
    status_line_at: null,
    unseen: false,
    asking: false,
    closing_line: null,
    blocked: null,
    ...listedSubtasks([]),
    todos: [],
    pr_states: prStates({}),
    ...extra,
  }
}

describe('agentPlaces', () => {
  it('lists pinned agents first, then the most recently active', () => {
    const places = agentPlaces([
      task('old', { updated_at: '2026-09-01T00:00:00Z' }),
      task('new', { updated_at: '2026-09-03T00:00:00Z' }),
      task('pinned', { pinned: true, updated_at: '2026-08-01T00:00:00Z' }),
    ])
    expect(places.map((p) => p.id)).toEqual(['agent:pinned', 'agent:new', 'agent:old'])
  })

  it('shows the status and the short name of where the agent works, with the full one as its title', () => {
    const [place] = agentPlaces([
      task('a', { status: 'running', repos: [{ id: 'r', slug: 'Octocat/seti' } as TaskListEntry['repos'][number]] }),
    ])
    expect(place).toMatchObject({
      status: 'running',
      detailTitle: 'Octocat/seti',
      target: { section: 'agents', id: 'a' },
    })
    expect(place?.detail).toMatch(/^seti, \d+[smhd] ago$/)
    const now = Date.parse('2026-09-03T00:05:00Z')
    const [b] = agentPlaces([task('b', { updated_at: '2026-09-03T00:00:00Z' })], now)
    expect(b).toMatchObject({ detail: 'b, 5m ago', detailTitle: '/work/b' })
  })

  it('still finds an agent by its full path', () => {
    expect(agentPlaces([task('b')])[0]?.keywords).toContain('/work/b')
  })

  it('carries the colour as a stripe and a word to search by', () => {
    const [place] = agentPlaces([task('c', { color: normalizeAgentColor('pink'), pinned: true })])
    expect(place).toMatchObject({ color: normalizeAgentColor('pink'), keywords: '/work/c pinned pink' })
    const custom = normalizeAgentColor('#1a3')
    expect(agentPlaces([task('e', { color: custom })])[0]?.keywords).toBe(`/work/e ${custom ?? ''}`)
    expect(agentPlaces([task('d')])[0]).toMatchObject({ color: null, keywords: '/work/d' })
  })
})

describe('other places', () => {
  it('names pull requests by title with repo#number below and opens them on GitHub', () => {
    const url = 'https://github.com/Octocat/seti/pull/42'
    const pr = { key: 'k1', repo_slug: 'Octocat/seti', number: 42, title: 'Palette', draft: false, author: 'me', url }
    const list = { repos: [{ prs: [pr as PullRequest] }] } as PrList
    const places = prPlaces(list)
    expect(places).toMatchObject([{ id: 'pr:k1', title: 'Palette', detail: 'Octocat/seti#42' }])
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    const target = places[0]?.target
    if (target !== undefined && 'run' in target) {
      target.run()
    }
    vi.unstubAllGlobals()
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer')
    expect(prPlaces(undefined)).toEqual([])
  })

  it('routes context packs through their pack selection', () => {
    const pack = { id: 'p1', name: 'Guide', description: '' } as ContextPack
    expect(contextPlaces([], [pack])).toMatchObject([
      { title: 'Guide', detail: 'Context pack', target: { section: 'context', id: 'pack:p1' } },
    ])
  })

  it('offers every section, the group chat and every settings page', () => {
    const openChat = vi.fn()
    const sections = sectionPlaces(openChat)
    expect(sections.map((p) => p.title)).toEqual([
      'EA',
      'Home',
      'Agents',
      'Questions',
      'Context',
      'Settings',
      'Group chat',
    ])
    expect(sections.find((p) => p.title === 'Questions')).toMatchObject({
      target: { section: 'questions' },
      keywords: 'Work answer agents ask secrets',
    })
    const chat = sections.at(-1)?.target
    if (chat !== undefined && 'run' in chat) {
      chat.run()
    }
    expect(openChat).toHaveBeenCalledOnce()
    const sets = settingsPlaces().find((p) => p.title === 'Credentials')
    expect(sets?.target).toEqual({ section: 'settings', id: 'credentials' })
    const hosts = settingsPlaces().find((p) => p.id === 'settings:ssh')
    expect(hosts).toMatchObject({ title: 'SSH', detail: 'Settings, Security', keywords: 'settings hosts keys' })
    expect(hosts?.target).toEqual({ section: 'settings', id: 'ssh' })
    const mods = settingsPlaces('Vim mode').find((p) => p.id === 'settings:mods')
    expect(mods?.keywords).toMatch(/ Vim mode$/u)
  })

  it('lists every settings page once, under its group', () => {
    const titles = settingsPlaces().map((p) => p.title)
    expect(new Set(titles).size).toBe(titles.length)
    const repos = settingsPlaces().find((p) => p.id === 'settings:repos')
    expect(repos).toMatchObject({ title: 'Repos', detail: 'Settings, Agents' })
    expect(repos?.target).toEqual({ section: 'settings', id: 'repos' })
    const signIn = settingsPlaces().find((p) => p.id === 'settings:signin')
    expect(signIn?.keywords).toContain('devices')
    expect(signIn?.target).toEqual({ section: 'settings', id: 'signin' })
  })
})
