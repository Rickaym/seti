import { recipientLabel, type TeamMessage } from '@seti/shared'
import { ArrowRight, Lock } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'

const authorName = (message: TeamMessage, handles: ReadonlyMap<string, string>) => {
  if (message.author_kind === 'mod') {
    return `the ${message.author_mod_id ?? 'unknown'} mod`
  }
  if (message.author_kind !== 'task') {
    return message.author_kind === 'ea' ? 'the EA' : 'you'
  }
  const id = message.author_task_id
  return `@${(id === null ? undefined : handles.get(id)) ?? message.author_handle ?? 'agent'}`
}

const recipientName = (message: TeamMessage, handles: ReadonlyMap<string, string>) => {
  const id = message.to_task_id
  const current = id === null ? undefined : handles.get(id)
  if (current !== undefined) {
    return `@${current}`
  }
  return message.to_kind === 'ea' ? 'EA' : (recipientLabel(message) ?? '')
}

/** Marks a direct message with its recipient; only its two parties and the user see it. */
export function DirectMark({ message, handles }: { message: TeamMessage; handles: ReadonlyMap<string, string> }) {
  const to = recipientName(message, handles)
  const from = authorName(message, handles)
  return (
    <Hint text={`Direct message: only ${from}, ${to === 'EA' ? 'the EA' : to} and you see it`}>
      <span
        className="inline-flex items-center gap-0.5 rounded-sm bg-muted px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground"
        data-testid="team-direct"
        aria-label={`Direct message to ${to}`}
      >
        <Lock className="size-3" />
        <ArrowRight className="size-3" />
        {to}
      </span>
    </Hint>
  )
}

/** Shows or hides the direct messages between the EA and agents. */
export function DirectToggle({ shown, onChange }: { shown: boolean; onChange: (shown: boolean) => void }) {
  return (
    <Hint text={shown ? 'Hide direct messages' : 'Show direct messages'}>
      <Button
        variant="ghost"
        size="icon-sm"
        className="ml-auto aria-pressed:bg-primary/10 aria-pressed:text-primary"
        aria-label="Direct messages"
        aria-pressed={shown}
        data-testid="team-direct-toggle"
        onClick={() => {
          onChange(!shown)
        }}
      >
        <Lock />
      </Button>
    </Hint>
  )
}
