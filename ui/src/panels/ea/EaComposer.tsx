import { Send, Square } from 'lucide-react'
import type { ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { RETRYING_LABEL } from '@/hooks/useClientSend'
import { useCoarsePointer } from '@/hooks/useMedia'
import { IDLE_COMMANDS } from '@/lib/command-catalog'
import { CommandField } from '@/panels/tasks/CommandField'

function hintFor(replying: boolean, touch: boolean): string {
  if (touch) {
    return replying ? 'Stop ends the reply; what the EA said so far stays.' : 'Send asks the EA.'
  }
  return replying ? 'Esc stops the reply; what the EA said so far stays.' : 'Enter sends, Ctrl+Enter adds a line.'
}

/** The reply box of the EA chat: the task composer's field, with Enter to send as in a chat. */
export function EaComposer({
  draft,
  onDraftChange,
  replying,
  retrying,
  disabled,
  onSend,
  onStop,
  actions,
}: {
  draft: string
  onDraftChange: (draft: string) => void
  replying: boolean
  /** The typed message waits to be sent again after a network fault. */
  retrying: boolean
  /** Why nothing can be sent now, or null. */
  disabled: string | null
  onSend: (text: string) => void
  onStop: () => void
  actions?: ReactNode
}) {
  const touch = useCoarsePointer()
  const blocked = replying || disabled !== null || draft.trim() === ''
  const send = () => {
    if (!blocked) {
      onSend(draft.trim())
    }
  }
  return (
    <div className="shrink-0 space-y-1 p-3 max-md:p-2">
      <div className="mx-auto flex w-full max-w-3xl gap-2">
        <CommandField
          value={draft}
          onChange={onDraftChange}
          commands={IDLE_COMMANDS}
          label="Message the EA"
          placeholder={touch ? 'Ask the EA' : 'Ask the EA about your agents, PRs and plans (Enter)'}
          rows={2}
          placement="above"
          primary
          enterSends={!touch}
          onSubmit={send}
        />
        {replying ? (
          <Hint text="Stop the reply (Esc)" side="top">
            <Button variant="outline" aria-label="Stop the reply" onClick={onStop}>
              <Square className="size-4" />
            </Button>
          </Hint>
        ) : (
          touch && (
            <Button aria-label="Send" onClick={send} disabled={blocked}>
              <Send className="size-4" />
            </Button>
          )
        )}
      </div>
      <div className="mx-auto flex min-h-6 w-full max-w-3xl items-center gap-2 pl-1">
        <p className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
          {disabled ?? (retrying ? RETRYING_LABEL : hintFor(replying, touch))}
        </p>
        {actions}
      </div>
    </div>
  )
}
