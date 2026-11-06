import { Bot } from 'lucide-react'

export function AgentChangedMark() {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 bg-actor-agent/20 px-1 py-px text-2xs font-semibold whitespace-nowrap text-foreground"
      title="An agent changed this since you last looked. Open it to see the history."
    >
      <Bot className="size-3" aria-hidden />
      changed by agent
    </span>
  )
}
