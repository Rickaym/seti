import type { TeamMember } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { rankMentions } from '@/lib/mentions'
import { activeHint, mentionOptions } from './mention-options'

const member = (handle: string, activeToday: boolean): TeamMember => ({
  task_id: `id-${handle}`,
  handle,
  title: `Task ${handle}`,
  status: 'idle',
  muted: false,
  active: activeToday,
  active_today: activeToday,
})

describe('activeHint', () => {
  it('counts the agents that worked today', () => {
    expect(activeHint([member('a', true), member('b', false), member('c', true)])).toBe('2 agents active today')
    expect(activeHint([member('a', true)])).toBe('1 agent active today')
    expect(activeHint([member('a', false)])).toBe('No agents active today')
    expect(activeHint([])).toBe('No agents active today')
  })
})

describe('mentionOptions', () => {
  it('offers @active next to @all, before agents', () => {
    const options = mentionOptions([member('agent', true), member('billing', false)])
    expect(rankMentions(options, '', 3).map((o) => [o.handle, o.detail])).toEqual([
      ['active', '1 agent active today'],
      ['all', 'Every active agent, at its next step'],
      ['ea', 'The EA'],
    ])
    expect(rankMentions(options, 'a', 3).map((o) => o.handle)).toEqual(['active', 'all', 'agent'])
  })
})
