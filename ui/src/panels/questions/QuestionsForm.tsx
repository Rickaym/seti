import type { Question } from '@seti/shared'
import { Send, SkipForward } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { QuestionField } from '@/panels/questions/QuestionField'
import { SecretField } from '@/panels/questions/SecretField'
import { draftOf } from '@/panels/questions/drafts'
import type { Answers } from '@/panels/questions/useAnswers'

/** A question with the field its kind takes: a masked one for a secret, else options. */
function OneQuestion({ question, answers }: { question: Question; answers: Answers }) {
  const dismiss = () => {
    answers.dispatch([{ action: 'dismiss', id: question.id }])
  }
  if (question.kind === 'secret') {
    return (
      <SecretField
        question={question}
        value={answers.secrets[question.id] ?? ''}
        onValue={(value) => {
          answers.onSecret(question.id, value)
        }}
        onDismiss={dismiss}
      />
    )
  }
  return (
    <QuestionField
      question={question}
      draft={draftOf(answers.drafts, question)}
      onDraft={(draft) => {
        answers.onDraft(question.id, draft)
      }}
      onDismiss={dismiss}
    />
  )
}

interface AgentQuestionsProps {
  title: string
  questions: readonly Question[]
  answers: Answers
}

/** One agent's open questions, with Skip for all of them. */
export function AgentQuestions({ title, questions, answers }: AgentQuestionsProps) {
  return (
    <section aria-label={`Questions from ${title}`} className="border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1">
        <span className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
          {questions.length === 1 ? '1 question' : `${String(questions.length)} questions`}
        </span>
        <Hint text="Dismiss all of this agent's questions; it goes on with its own judgment">
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Skip ${title}`}
            className="pointer-coarse:min-h-11"
            onClick={() => {
              answers.dispatch(questions.map((question) => ({ action: 'dismiss', id: question.id })))
            }}
          >
            <SkipForward />
            Skip
          </Button>
        </Hint>
      </div>
      <div className="divide-y divide-border px-3">
        {questions.map((question) => (
          <OneQuestion key={question.id} question={question} answers={answers} />
        ))}
      </div>
    </section>
  )
}

/** How many questions are answered, then what a send did, beside one Submit for all of them. */
export function SubmitBar({ answers, label }: { answers: Answers; label: string }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-border px-5 py-2 max-md:px-3">
      <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">
        {answers.summary ?? `${String(answers.ready)} of ${String(answers.total)} answered`}
      </p>
      <Hint text="Send every answered question; agents with all their answers go on">
        <Button
          disabled={answers.ready === 0 || answers.sending}
          className="pointer-coarse:min-h-11"
          onClick={answers.submit}
        >
          <Send />
          {label}
        </Button>
      </Hint>
    </div>
  )
}
