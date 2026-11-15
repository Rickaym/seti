import type { Question, QuestionAnswerItem } from '@seti/shared'
import { useState } from 'react'
import { answerItem, draftOf, isAnswered, type Draft } from '@/panels/questions/drafts'
import { useSend, type SecretEntry } from '@/panels/questions/useSend'

const without = <T>(record: Readonly<Record<string, T>>, ids: readonly string[]) =>
  Object.fromEntries(Object.entries(record).filter(([id]) => !ids.includes(id)))

/** Whether Submit all sends the question: a secret with a value, else a picked or written answer. */
const isReady = (
  question: Question,
  drafts: Readonly<Record<string, Draft>>,
  secrets: Readonly<Record<string, string>>,
) => (question.kind === 'secret' ? (secrets[question.id] ?? '') !== '' : isAnswered(draftOf(drafts, question)))

/**
 * The user's drafts for open questions and how they go out: one question or agent at a time, or
 * every answered one with Submit all. `onSettled` gets the summary of a send that left none of
 * `questions` open.
 */
export function useAnswers(questions: readonly Question[], onSettled: (summary: string) => void) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const { send, sending, summary } = useSend((ids) => {
    setDrafts((prev) => without(prev, ids))
    setSecrets((prev) => without(prev, ids))
  })
  const dispatch = (items: QuestionAnswerItem[], entries: readonly SecretEntry[] = []) => {
    const asked = questions.map((question) => question.id)
    void send(items, entries).then((result) => {
      if (result.summary !== null && asked.every((id) => result.sent.includes(id))) {
        onSettled(result.summary)
      }
    })
  }
  const ready = questions.filter((question) => isReady(question, drafts, secrets))
  const submit = () => {
    const [secret, plain] = [ready.filter((q) => q.kind === 'secret'), ready.filter((q) => q.kind !== 'secret')]
    const entries = secret.map((question) => ({ id: question.id, value: secrets[question.id] ?? '' }))
    dispatch(
      plain.map((question) => answerItem(question, draftOf(drafts, question))),
      entries,
    )
  }
  return {
    drafts,
    onDraft: (id: string, draft: Draft) => {
      setDrafts((prev) => ({ ...prev, [id]: draft }))
    },
    secrets,
    onSecret: (id: string, value: string) => {
      setSecrets((prev) => ({ ...prev, [id]: value }))
    },
    dispatch,
    submit,
    ready: ready.length,
    total: questions.length,
    sending,
    summary,
  }
}

export type Answers = ReturnType<typeof useAnswers>
