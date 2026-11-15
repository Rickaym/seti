import type { Question } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import {
  answerItem,
  asksForSecret,
  draftOf,
  EMPTY_DRAFT,
  initialDraft,
  isAnswered,
  sentSummary,
  shownLabel,
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
  secret: null,
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

  it('sums up a send', () => {
    expect(
      sentSummary({ answered: 3, dismissed: 1, skipped: 0, resumed: [{ task_id: 't1', task_title: 'Builder' }] }),
    ).toBe('Sent 3 answers, dismissed 1 question. Going on: Builder.')
    expect(sentSummary({ answered: 0, dismissed: 0, skipped: 2, resumed: [] })).toBe(
      'Nothing sent. 2 questions had closed already.',
    )
  })

  it('starts with the recommended option picked, by its exact label', () => {
    const options = [
      { label: 'Unit', description: null },
      { label: 'Lint (Recommended)', description: null },
      { label: 'E2E (recommended)', description: null },
    ]
    const single = question({ options })
    expect(initialDraft(single)).toEqual({ selected: ['Lint (Recommended)'], other: '' })
    expect(initialDraft(question({ options, multi: true })).selected).toEqual([
      'Lint (Recommended)',
      'E2E (recommended)',
    ])
    expect(initialDraft(question())).toEqual(EMPTY_DRAFT)
    expect(isAnswered(draftOf({}, single))).toBe(true)
    expect(answerItem(single, draftOf({}, single))).toMatchObject({ selected: ['Lint (Recommended)'] })
    expect(draftOf({ [single.id]: EMPTY_DRAFT }, single)).toBe(EMPTY_DRAFT)
    expect(shownLabel('Lint (Recommended)')).toBe('Lint')
  })

  it('spots a question that asks for a secret', () => {
    expect(asksForSecret(question({ prompt: 'What is the API key for staging?' }))).toBe(true)
    expect(asksForSecret(question())).toBe(false)
  })
})
