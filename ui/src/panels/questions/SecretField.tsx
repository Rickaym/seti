import type { Question } from '@seti/shared'
import { Eye, EyeOff, KeyRound, X } from 'lucide-react'
import { useId, useState } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface SecretFieldProps {
  question: Question
  value: string
  onValue: (value: string) => void
  onDismiss: () => void
}

/** Where the value goes, in the words the user reads before entering it. */
function deliveryText(question: Question): string {
  const secret = question.secret
  if (secret?.delivery === 'secret_store') {
    return `Seti keeps it in its secret store and adds it only on ${secret.hosts.join(', ')}; the agent never sees it.`
  }
  return 'Seti saves it to a file only Seti can read and gives the agent its path, never the value.'
}

/** A secret an agent asked for with ask_secret: its name, why, where it goes and a masked field. */
export function SecretField({ question, value, onValue, onDismiss }: SecretFieldProps) {
  const [shown, setShown] = useState(false)
  const heading = useId()
  const name = question.secret?.name ?? question.header
  const toggle = shown ? 'Hide value' : 'Show value'
  return (
    <section aria-labelledby={heading} data-question-id={question.id} className="space-y-2 py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 id={heading} className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <KeyRound aria-hidden className="size-3.5 shrink-0" />
            <span>Secret</span>
            <span className="font-mono break-all text-foreground">{name}</span>
          </h3>
          <p className="text-sm break-words">{question.prompt}</p>
          <p className="text-xs text-muted-foreground">{deliveryText(question)}</p>
        </div>
        <Hint text="Dismiss this request without giving the secret; the agent goes on without it">
          <Button variant="ghost" size="icon-sm" aria-label={`Dismiss ${name}`} onClick={onDismiss}>
            <X />
          </Button>
        </Hint>
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          aria-label={`Value of ${name}`}
          type={shown ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          className="font-mono pointer-coarse:min-h-11"
          placeholder="Enter the value"
          value={value}
          onChange={(event) => {
            onValue(event.target.value)
          }}
        />
        <Button
          size="icon"
          variant="outline"
          aria-label={toggle}
          title={toggle}
          aria-pressed={shown}
          className="pointer-coarse:size-11"
          onClick={() => {
            setShown((prev) => !prev)
          }}
        >
          {shown ? <EyeOff /> : <Eye />}
        </Button>
      </div>
    </section>
  )
}
