import type { Question, QuestionAnswerItem } from '@seti/shared'
import { MessageCircleQuestion, Send, SkipForward } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { navigate } from '@/lib/route'
import { QuestionField } from '@/panels/questions/QuestionField'
import { SecretField } from '@/panels/questions/SecretField'
import { answerItem, byAgent, draftOf, isAnswered, type Draft } from '@/panels/questions/drafts'
import { useSend, type SecretEntry } from '@/panels/questions/useSend'

interface AgentQuestionsProps {
  taskId: string
  title: string
  questions: readonly Question[]
  drafts: Readonly<Record<string, Draft>>
  onDraft: (id: string, draft: Draft) => void
  secrets: Readonly<Record<string, string>>
  onSecret: (id: string, value: string) => void
  onSend: (items: QuestionAnswerItem[]) => void
}

/** One agent's open questions, with Skip for all of them. */
function AgentQuestions(props: AgentQuestionsProps) {
  const { taskId, title, questions, onSend } = props
  return (
    <section aria-label={`Questions from ${title}`} data-task-id={taskId} className="border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm font-semibold hover:underline"
          onClick={() => {
            navigate('agents', taskId)
          }}
        >
          {title}
        </button>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{questions.length}</span>
        <Hint text="Dismiss all of this agent's questions; it goes on with its own judgment">
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Skip ${title}`}
            onClick={() => {
              onSend(questions.map((question) => ({ action: 'dismiss', id: question.id })))
            }}
          >
            <SkipForward />
            Skip
          </Button>
        </Hint>
      </div>
      <div className="divide-y divide-border px-3">
        {questions.map((question) => (
          <OneQuestion key={question.id} question={question} {...props} />
        ))}
      </div>
    </section>
  )
}

/** A question with the field its kind takes: a masked one for a secret, else options. */
function OneQuestion({
  question,
  drafts,
  onDraft,
  secrets,
  onSecret,
  onSend,
}: AgentQuestionsProps & { question: Question }) {
  const dismiss = () => {
    onSend([{ action: 'dismiss', id: question.id }])
  }
  if (question.kind === 'secret') {
    return (
      <SecretField
        question={question}
        value={secrets[question.id] ?? ''}
        onValue={(value) => {
          onSecret(question.id, value)
        }}
        onDismiss={dismiss}
      />
    )
  }
  return (
    <QuestionField
      question={question}
      draft={draftOf(drafts, question)}
      onDraft={(draft) => {
        onDraft(question.id, draft)
      }}
      onDismiss={dismiss}
    />
  )
}

const without = <T,>(record: Readonly<Record<string, T>>, ids: readonly string[]) =>
  Object.fromEntries(Object.entries(record).filter(([id]) => !ids.includes(id)))

/** Whether Submit all sends the question: a secret with a value, else a picked or written answer. */
const isReady = (
  question: Question,
  drafts: Readonly<Record<string, Draft>>,
  secrets: Readonly<Record<string, string>>,
) => (question.kind === 'secret' ? (secrets[question.id] ?? '') !== '' : isAnswered(draftOf(drafts, question)))

interface QuestionsFormProps {
  questions: readonly Question[]
  /** The submit button's label, such as Submit all on the page that holds every agent's. */
  submitLabel: string
  /** Runs with what a send did once it left none of `questions` open. */
  onSettled: (summary: string) => void
}

/**
 * Open questions grouped by agent, oldest agent first, with Dismiss, Skip and one Submit for
 * every answered one. Each agent waits until all of its questions are answered or dismissed.
 */
export function QuestionsForm({ questions, submitLabel, onSettled }: QuestionsFormProps) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const groups = useMemo(() => byAgent(questions), [questions])
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
  return (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 max-md:px-3 max-md:py-3">
        {groups.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <MessageCircleQuestion aria-hidden className="size-4" />
            No open questions. Agents ask here when they need you to decide something.
          </p>
        )}
        {groups.map((group) => (
          <AgentQuestions
            key={group.taskId}
            {...group}
            drafts={drafts}
            onDraft={(id, draft) => {
              setDrafts((prev) => ({ ...prev, [id]: draft }))
            }}
            secrets={secrets}
            onSecret={(id, value) => {
              setSecrets((prev) => ({ ...prev, [id]: value }))
            }}
            onSend={dispatch}
          />
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-border px-5 py-2 max-md:px-3">
        <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">
          {summary ?? `${String(ready.length)} of ${String(questions.length)} answered`}
        </p>
        <Hint text="Send every answered question; agents with all their answers go on">
          <Button disabled={ready.length === 0 || sending} className="pointer-coarse:min-h-11" onClick={submit}>
            <Send />
            {submitLabel}
          </Button>
        </Hint>
      </div>
    </>
  )
}
