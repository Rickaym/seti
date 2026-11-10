import type { AnswerQuestionsResult, Question, QuestionAnswerItem } from '@seti/shared'
import { MessageCircleQuestion, Send, SkipForward } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { BackButton, DetailHeader, DetailTitle } from '@/components/SplitPane'
import { Button } from '@/components/ui/button'
import { refreshQuestions, useOpenQuestions } from '@/hooks/useQuestions'
import { navigate } from '@/lib/route'
import { QuestionField } from '@/panels/questions/QuestionField'
import { answerItem, byAgent, EMPTY_DRAFT, isAnswered, sentSummary, type Draft } from '@/panels/questions/drafts'

interface AgentQuestionsProps {
  taskId: string
  title: string
  questions: readonly Question[]
  drafts: Readonly<Record<string, Draft>>
  onDraft: (id: string, draft: Draft) => void
  onSend: (items: QuestionAnswerItem[]) => void
}

/** One agent's open questions, with Skip for all of them. */
function AgentQuestions({ taskId, title, questions, drafts, onDraft, onSend }: AgentQuestionsProps) {
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
          <QuestionField
            key={question.id}
            question={question}
            draft={drafts[question.id] ?? EMPTY_DRAFT}
            onDraft={(draft) => {
              onDraft(question.id, draft)
            }}
            onDismiss={() => {
              onSend([{ action: 'dismiss', id: question.id }])
            }}
          />
        ))}
      </div>
    </section>
  )
}

/** Sends answers and dismissals, and says what went out. */
function useSend(onSent: (ids: readonly string[]) => void) {
  const [sending, setSending] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  const send = (items: QuestionAnswerItem[]) => {
    setSending(true)
    apiPost<AnswerQuestionsResult>('/questions/answers', { items })
      .then((result) => {
        setSummary(sentSummary(result))
        onSent(items.map((item) => item.id))
      })
      .catch((e: unknown) => toast.error(errorText(e)))
      .finally(() => {
        setSending(false)
        refreshQuestions()
      })
  }
  return { send, sending, summary }
}

/**
 * Every agent's open questions in one place, oldest agent first. Each agent waits until all of
 * its questions are answered or dismissed; Submit all sends every answered one at once.
 */
export function QuestionsPage() {
  const open = useOpenQuestions()
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const groups = useMemo(() => byAgent(open), [open])
  const { send, sending, summary } = useSend((ids) => {
    setDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !ids.includes(id))))
  })
  const ready = open.filter((question) => isAnswered(drafts[question.id]))
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DetailHeader>
        <div className="flex items-center gap-2">
          <BackButton section="agents" label="agents" />
          <DetailTitle>Questions</DetailTitle>
        </div>
        <div className="text-xs text-muted-foreground">
          What your agents wait on you for. Each agent goes on once all its questions are answered or dismissed.
        </div>
      </DetailHeader>
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
            onSend={send}
          />
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-border px-5 py-2 max-md:px-3">
        <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">
          {summary ?? `${String(ready.length)} of ${String(open.length)} answered`}
        </p>
        <Hint text="Send every answered question; agents with all their answers go on">
          <Button
            disabled={ready.length === 0 || sending}
            className="pointer-coarse:min-h-11"
            onClick={() => {
              send(ready.map((question) => answerItem(question, drafts[question.id] ?? EMPTY_DRAFT)))
            }}
          >
            <Send />
            Submit all
          </Button>
        </Hint>
      </div>
    </div>
  )
}
