import { activeReach, type TeamMessage } from '@seti/shared'
import { Users } from 'lucide-react'

/** Names the agents @active reached, as stored when the message was posted. */
export function ActiveReach({ message }: { message: TeamMessage }) {
  const reach = activeReach(message.mentions)
  if (reach === null) {
    return null
  }
  const handles = reach.map((mention) => `@${mention.handle}`).join(', ')
  return (
    <p className="mt-0.5 flex items-start gap-1 text-2xs text-muted-foreground" data-testid="team-active-reach">
      <Users className="mt-px size-3 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">
        {reach.length === 0 ? '@active reached nobody: no agent was active today' : `@active reached ${handles}`}
      </span>
    </p>
  )
}
