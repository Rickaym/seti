import { QUESTION_OTHER_MAX, type Question, type QuestionOption } from '@seti/shared'
import { Check, ShieldAlert, X } from 'lucide-react'
import { useId } from 'react'
import { Hint } from '@/components/Hint'
import { Markdown } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  asksForSecret,
  isRecommended,
  shownLabel,
  toggleOption,
  writeOther,
  type Draft,
} from '@/panels/questions/drafts'

interface FieldProps {
  question: Question
  draft: Draft
  onDraft: (draft: Draft) => void
}

const OPTION =
  'flex min-h-9 w-full items-start gap-2 border border-border px-3 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11'

function OptionText({ option }: { option: QuestionOption }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-1.5 font-medium">
        {shownLabel(option.label)}
        {isRecommended(option.label) && (
          <span className="rounded-sm border border-border px-1 text-2xs font-normal text-muted-foreground">
            Recommended
          </span>
        )}
      </span>
      {option.description !== null && <span className="block text-xs text-muted-foreground">{option.description}</span>}
    </span>
  )
}

/** Yes and No side by side, as one pick. */
function YesNo({ question, draft, onDraft }: FieldProps) {
  return (
    <div role="radiogroup" aria-label={question.header} className="flex gap-2">
      {question.options.map((option) => {
        const picked = draft.selected.includes(option.label)
        return (
          <Button
            key={option.label}
            role="radio"
            aria-checked={picked}
            variant={picked ? 'default' : 'outline'}
            className="min-w-20 flex-1 pointer-coarse:min-h-11 sm:flex-none"
            title={option.description ?? undefined}
            onClick={() => {
              onDraft(toggleOption(question, draft, option.label))
            }}
          >
            {picked && <Check />}
            {option.label}
          </Button>
        )
      })}
    </div>
  )
}

/** One pick of several options, each with what it means. */
function SingleChoice({ question, draft, onDraft }: FieldProps) {
  return (
    <div role="radiogroup" aria-label={question.header} className="space-y-1">
      {question.options.map((option) => {
        const picked = draft.selected.includes(option.label)
        return (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={picked}
            className={cn(OPTION, picked && 'border-primary bg-accent')}
            onClick={() => {
              onDraft(toggleOption(question, draft, option.label))
            }}
          >
            <span
              aria-hidden
              className={cn(
                'mt-0.5 size-3.5 shrink-0 rounded-full border border-input',
                picked && 'border-4 border-primary',
              )}
            />
            <OptionText option={option} />
          </button>
        )
      })}
    </div>
  )
}

/** Any number of options, each a checkbox. */
function MultiChoice({ question, draft, onDraft }: FieldProps) {
  const id = useId()
  return (
    <div role="group" aria-label={question.header} className="space-y-1">
      {question.options.map((option, index) => {
        const box = `${id}-${String(index)}`
        return (
          <label key={option.label} htmlFor={box} className={cn(OPTION, 'cursor-pointer')}>
            <Checkbox
              id={box}
              className="mt-0.5"
              checked={draft.selected.includes(option.label)}
              onCheckedChange={() => {
                onDraft(toggleOption(question, draft, option.label))
              }}
            />
            <OptionText option={option} />
          </label>
        )
      })}
    </div>
  )
}

function SecretNote() {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>
        This asks for a secret. Do not answer it here: dismiss it and tell the agent to ask with ask_secret, which keeps
        the value out of its transcript.
      </span>
    </p>
  )
}

/** One open question with the control its type takes, its own-words field and Dismiss. */
export function QuestionField({ question, draft, onDraft, onDismiss }: FieldProps & { onDismiss: () => void }) {
  const choice = question.multi ? MultiChoice : SingleChoice
  const Control = question.kind === 'yes_no' ? YesNo : choice
  const heading = useId()
  return (
    <section aria-labelledby={heading} data-question-id={question.id} className="space-y-2 py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 id={heading} className="text-xs font-semibold text-muted-foreground">
            {question.header}
            {question.multi && <span className="font-normal"> (any that apply)</span>}
            {question.subagent_id !== null && <span className="font-normal"> (from a subagent)</span>}
          </h3>
          <div className="text-sm">
            <Markdown text={question.prompt} />
          </div>
        </div>
        <Hint text="Dismiss this question without answering; the agent decides itself">
          <Button variant="ghost" size="icon-sm" aria-label={`Dismiss ${question.header}`} onClick={onDismiss}>
            <X />
          </Button>
        </Hint>
      </div>
      {asksForSecret(question) && <SecretNote />}
      <Control question={question} draft={draft} onDraft={onDraft} />
      <Input
        aria-label={`Other answer to ${question.header}`}
        placeholder="Other: answer in your own words"
        value={draft.other}
        maxLength={QUESTION_OTHER_MAX}
        onChange={(event) => {
          onDraft(writeOther(question, draft, event.target.value))
        }}
      />
    </section>
  )
}
