import type { EaTool } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { countText, groupTools, matchTools } from './tool-list'

const TOOLS: EaTool[] = [
  { name: 'list_tasks', area: 'Agents', summary: 'List Seti tasks.', gate: 'runs' },
  { name: 'list_prs', area: 'PRs and repos', summary: 'List the PRs.', gate: 'runs' },
  { name: 'stop_task', area: 'Agents', summary: 'Stop a running task.', gate: 'asks' },
  { name: 'answer_question', area: 'Messaging', summary: "Answer an agent's question.", gate: 'word' },
]

describe('countText', () => {
  it('counts every tool and the ones that wait for the user', () => {
    expect(countText(TOOLS)).toBe('4 tools; 1 asks first; 1 on your word')
    expect(countText(TOOLS.slice(0, 2))).toBe('2 tools; 0 ask first')
  })
})

describe('matchTools', () => {
  it('finds tools by any of their words, with underscores read as spaces', () => {
    expect(matchTools(TOOLS, '').map((t) => t.name)).toEqual(TOOLS.map((t) => t.name))
    expect(matchTools(TOOLS, 'stop task').map((t) => t.name)).toEqual(['stop_task'])
    expect(matchTools(TOOLS, 'ASKS first').map((t) => t.name)).toEqual(['stop_task'])
    expect(matchTools(TOOLS, 'repos').map((t) => t.name)).toEqual(['list_prs'])
    expect(matchTools(TOOLS, 'nothing like it')).toEqual([])
  })
})

describe('groupTools', () => {
  it('keeps areas in the order their first tool comes', () => {
    expect(groupTools(TOOLS).map((g) => [g.area, g.tools.map((t) => t.name)])).toEqual([
      ['Agents', ['list_tasks', 'stop_task']],
      ['PRs and repos', ['list_prs']],
      ['Messaging', ['answer_question']],
    ])
  })
})
