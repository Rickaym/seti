import { type AnswerQuestionsResult, type Question, type QuestionAnswerItem } from '@seti/shared'

/** What the user has picked and written for one question before sending it. */
export interface Draft {
  selected: readonly string[]
  other: string
}

export const EMPTY_DRAFT: Draft = { selected: [], other: '' }

const MARK = '(recommended)'

/** Whether the agent marked the option as its recommendation, as Claude Code's convention has it. */
export const isRecommended = (label: string) => label.trimEnd().toLowerCase().endsWith(MARK)

/** The option's label without the recommendation mark, which the page shows as a tag instead. */
export const shownLabel = (label: string) =>
  isRecommended(label) ? label.trimEnd().slice(0, -MARK.length).trimEnd() : label

/**
 * The draft a question starts with: its recommended option picked, or every recommended one on a
 * multi-answer question; the exact labels, as AskUserQuestion takes them back.
 */
export function initialDraft(question: Question): Draft {
  const recommended = question.options.map((option) => option.label).filter(isRecommended)
  return { selected: question.multi ? recommended : recommended.slice(0, 1), other: '' }
}

/** The user's draft for the question, else the one it starts with. */
export const draftOf = (drafts: Readonly<Record<string, Draft>>, question: Question) =>
  drafts[question.id] ?? initialDraft(question)

/** Picks or unpicks an option; a single-answer question keeps only the latest pick. */
export function toggleOption(question: Question, draft: Draft, label: string): Draft {
  if (!question.multi) {
    return { selected: draft.selected.includes(label) ? [] : [label], other: '' }
  }
  const selected = draft.selected.includes(label)
    ? draft.selected.filter((picked) => picked !== label)
    : [...draft.selected, label]
  return { ...draft, selected }
}

/** Writes the user's own words; on a single-answer question they replace the pick. */
export function writeOther(question: Question, draft: Draft, other: string): Draft {
  return question.multi || other.trim() === '' ? { ...draft, other } : { selected: [], other }
}

export const isAnswered = (draft: Draft | undefined) =>
  draft !== undefined && (draft.selected.length > 0 || draft.other.trim() !== '')

/** The answer Submit all sends for the draft. */
export const answerItem = (question: Question, draft: Draft): QuestionAnswerItem => ({
  action: 'answer',
  id: question.id,
  selected: [...draft.selected],
  other: draft.other.trim() === '' ? null : draft.other.trim(),
})

/** Open questions by agent, each agent at the time of its oldest question. */
export function byAgent(questions: readonly Question[]): { taskId: string; title: string; questions: Question[] }[] {
  const groups = new Map<string, { taskId: string; title: string; questions: Question[] }>()
  for (const question of questions) {
    const group = groups.get(question.task_id) ?? {
      taskId: question.task_id,
      title: question.task_title,
      questions: [],
    }
    group.questions.push(question)
    groups.set(question.task_id, group)
  }
  return [...groups.values()]
}

const count = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`

/** One line saying what a send did. */
export function sentSummary(result: AnswerQuestionsResult): string {
  const parts = [
    result.answered > 0 ? `Sent ${count(result.answered, 'answer')}` : null,
    result.dismissed > 0 ? `dismissed ${count(result.dismissed, 'question')}` : null,
  ].filter((part) => part !== null)
  const done = parts.length === 0 ? 'Nothing sent' : parts.join(', ')
  const resumed = result.resumed.map((agent) => agent.task_title)
  const going = resumed.length > 0 ? `. Going on: ${resumed.join(', ')}` : ''
  const late = result.skipped > 0 ? `. ${count(result.skipped, 'question')} had closed already` : ''
  return `${done}${going}${late}.`
}

const SECRET_WORDS = ['secret', 'token', 'password', 'passphrase', 'api key', 'apikey', 'credential', 'private key']

/** Whether the question asks for something that belongs in Credentials, not in an answer. */
export function asksForSecret(question: Question): boolean {
  const text = `${question.header} ${question.prompt}`.toLowerCase()
  return SECRET_WORDS.some((word) => text.includes(word))
}
