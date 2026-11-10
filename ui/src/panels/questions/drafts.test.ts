import type { Question } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import {
  answerItem,
  asksForSecret,
  byAgent,
  EMPTY_DRAFT,
  isAnswered,
  sentSummary,
  toggleOption,
  writeOther,
} from '@/panels/questions/drafts'

const question = (extra: Partial<Question> = {}): Question => ({
  id: '00000000-0000-4000-8000-000000000001',
  group_id: 'g1',
  task_id: 't1',
  task_title: 'Builder',
  subagent_id: null,
  tool_use_id: 'toolu_1',
  position: 0,
  header: 'Checks',
  prompt: 'Which checks?',
  kind: 'choice',
  multi: false,
  options: [
    { label: 'Unit', description: null },
    { label: 'Lint', description: null },
  ],
  status: 'open',
  answer: null,
  answered_by: null,
  created_at: '2026-11-10T10:00:00.000Z',
  settled_at: null,
  ...extra,
})

describe('question drafts', () => {
  it('keeps one pick on a single-answer question, where own words replace it', () => {
    const single = question()
    const picked = toggleOption(single, EMPTY_DRAFT, 'Unit')
    expect(toggleOption(single, picked, 'Lint')).toEqual({ selected: ['Lint'], other: '' })
    expect(writeOther(single, picked, 'Both')).toEqual({ selected: [], other: 'Both' })
    expect(toggleOption(single, { selected: [], other: 'Both' }, 'Unit')).toEqual({ selected: ['Unit'], other: '' })
  })

  it('adds and removes picks on a multi-answer question, beside own words', () => {
    const multi = question({ multi: true })
    const both = toggleOption(multi, toggleOption(multi, EMPTY_DRAFT, 'Unit'), 'Lint')
    expect(writeOther(multi, both, 'and e2e')).toEqual({ selected: ['Unit', 'Lint'], other: 'and e2e' })
    expect(toggleOption(multi, both, 'Unit').selected).toEqual(['Lint'])
  })

  it('sends only answered drafts, with blank own words left out', () => {
    expect(isAnswered(undefined)).toBe(false)
    expect(isAnswered({ selected: [], other: '  ' })).toBe(false)
    expect(answerItem(question(), { selected: ['Unit'], other: ' ' })).toEqual({
      action: 'answer',
      id: question().id,
      selected: ['Unit'],
      other: null,
    })
  })

  it('groups questions by agent and sums up a send', () => {
    const other = question({ id: 'q2', task_id: 't2', task_title: 'Tester' })
    expect(byAgent([question(), other, question({ id: 'q3' })]).map((group) => group.questions.length)).toEqual([2, 1])
    expect(
      sentSummary({ answered: 3, dismissed: 1, skipped: 0, resumed: [{ task_id: 't1', task_title: 'Builder' }] }),
    ).toBe('Sent 3 answers, dismissed 1 question. Going on: Builder.')
    expect(sentSummary({ answered: 0, dismissed: 0, skipped: 2, resumed: [] })).toBe(
      'Nothing sent. 2 questions had closed already.',
    )
  })

  it('spots a question that asks for a secret', () => {
    expect(asksForSecret(question({ prompt: 'What is the API key for staging?' }))).toBe(true)
    expect(asksForSecret(question())).toBe(false)
  })
})
