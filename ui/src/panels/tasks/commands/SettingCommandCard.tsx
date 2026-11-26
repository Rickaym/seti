import { Play, X, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import type { CommandCard, SettingCommand } from './useSettingCommand'

const TOUCH = 'pointer-coarse:min-h-11'

/** Esc on a card's button closes the card and keeps the agent's turn going. */
const closeOnEscape = (command: SettingCommand) => (e: KeyboardEvent) => {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault()
    command.dismiss()
  }
}

interface Ask {
  icon: LucideIcon
  title: string
  message: string
  detail: string | null
  label: string
  destructive: boolean
}

/** What the card asks first: the settings' own question, or whether to run an untyped line. */
function askOf(card: CommandCard, line: string): Ask | null {
  if (card.kind === 'untrusted') {
    return {
      icon: Play,
      title: `Run ${line.trim()}?`,
      message: 'This line was not typed here, so it waits for you.',
      detail: null,
      label: 'Run',
      destructive: false,
    }
  }
  if (card.kind === 'confirm') {
    const q = card.question
    return {
      icon: q.icon ?? Play,
      title: q.title ?? card.command.description,
      message: q.message,
      detail: q.detail ?? null,
      label: q.confirmLabel ?? 'Confirm',
      destructive: q.variant === 'destructive',
    }
  }
  return null
}

function AskBody({ ask, command }: { ask: Ask; command: SettingCommand }) {
  const go = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    go.current?.focus()
  }, [])
  return (
    <div className="grid gap-2">
      <div className="grid gap-0.5">
        <p className="font-semibold">{ask.title}</p>
        <p>{ask.message}</p>
        {ask.detail !== null && <p className="text-muted-foreground">{ask.detail}</p>}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          className={TOUCH}
          onKeyDown={closeOnEscape(command)}
          onClick={command.dismiss}
        >
          <X />
          Cancel
        </Button>
        <Button
          ref={go}
          variant={ask.destructive ? 'destructive' : 'default'}
          size="sm"
          className={TOUCH}
          onKeyDown={closeOnEscape(command)}
          onClick={command.confirm}
        >
          <ask.icon />
          {ask.label}
        </Button>
      </div>
    </div>
  )
}

/**
 * The small card above the reply box after a Seti command's Enter: why it cannot run, the
 * settings' own question with Confirm and Cancel, or Run for a line that was not typed here.
 */
export function SettingCommandCard({
  command,
  dialog,
}: {
  command: SettingCommand | null
  dialog: ReactElement | null
}): ReactElement | null {
  const card = command?.card ?? null
  if (command === null || card === null) {
    return dialog
  }
  const ask = askOf(card, command.line)
  return (
    <>
      <div
        role="group"
        aria-label={`Command ${command.line.trim().split(/\s/)[0] ?? ''}`}
        data-testid="setting-command"
        className="grid gap-1.5 border border-border bg-popover p-2 text-xs text-popover-foreground"
      >
        {ask === null ? (
          <p className="text-muted-foreground">{card.kind === 'refuse' ? card.reason : ''}</p>
        ) : (
          <AskBody ask={ask} command={command} />
        )}
      </div>
      {dialog}
    </>
  )
}
