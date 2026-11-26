import { Check, Play, X } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { keepFocus } from '@/lib/keep-focus'
import type { SettingCommand } from './useSettingCommand'

const TOUCH = 'pointer-coarse:min-h-11'

/** Esc on a card's button closes the card and keeps the agent's turn going. */
const closeOnEscape = (command: SettingCommand) => (e: KeyboardEvent) => {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault()
    command.dismiss()
  }
}

function Choices({ command }: { command: SettingCommand }) {
  const step = command.step
  if (step?.kind !== 'choose') {
    return null
  }
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={step.prompt}>
      {step.choices.map((item) => (
        <Button
          key={item.args}
          variant={item.current ? 'secondary' : 'outline'}
          size="sm"
          className={TOUCH}
          aria-pressed={item.current}
          onMouseDown={keepFocus}
          onKeyDown={closeOnEscape(command)}
          onClick={() => {
            command.choose(item)
          }}
        >
          {item.current && <Check aria-hidden />}
          {item.label}
          {item.detail !== null && <span className="text-muted-foreground">{item.detail}</span>}
        </Button>
      ))}
    </div>
  )
}

interface Ask {
  title: string
  message: string
  detail: string | null
  label: string
  destructive: boolean
}

/** What the card asks before running: the cog's own question, or whether to run an untyped line. */
function askOf(command: SettingCommand): Ask | null {
  const name = `/${command.line.setting.command.name}`
  const { step, phase } = command
  if (phase === 'untrusted') {
    return {
      title: `Run ${name}?`,
      message: 'This line was not typed here, so it waits for you.',
      detail: command.line.setting.command.description,
      label: 'Run',
      destructive: false,
    }
  }
  if (step?.kind === 'confirm') {
    const q = step.question
    return {
      title: q.title ?? name,
      message: q.message,
      detail: q.detail ?? null,
      label: q.confirmLabel ?? 'Confirm',
      destructive: q.variant === 'destructive',
    }
  }
  if (step?.kind === 'run') {
    return {
      title: name,
      message: command.line.setting.command.description,
      detail: null,
      label: 'Run',
      destructive: false,
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
          <Play />
          {ask.label}
        </Button>
      </div>
    </div>
  )
}

function CardBody({ command }: { command: SettingCommand }) {
  const ask = command.phase === 'live' ? null : askOf(command)
  if (ask !== null) {
    return <AskBody ask={ask} command={command} />
  }
  if (command.error !== null) {
    return <p className="text-destructive">{command.error}</p>
  }
  const step = command.step
  if (step === null) {
    return <p className="text-muted-foreground">Loading...</p>
  }
  if (step.kind === 'refuse') {
    return <p className="text-muted-foreground">{step.reason}</p>
  }
  return <Choices command={command} />
}

/** Whether the card has anything to show in its phase. */
function shown(command: SettingCommand): boolean {
  if (command.phase === null) {
    return false
  }
  return command.phase !== 'live' || command.step?.kind === 'choose' || command.step?.kind === 'refuse'
}

/**
 * The small card above the reply box for a setting command: its choices, the cog's confirmation
 * with Confirm and Cancel, or Run for a line that was not typed here. Esc closes it.
 */
export function SettingCommandCard({ command }: { command: SettingCommand | null }): ReactElement | null {
  if (command === null || !shown(command)) {
    return command?.dialog ?? null
  }
  return (
    <>
      <div
        role="group"
        aria-label={`Command /${command.line.setting.command.name}`}
        data-testid="setting-command"
        className="grid gap-1.5 border border-border bg-popover p-2 text-xs text-popover-foreground"
      >
        <CardBody command={command} />
      </div>
      {command.dialog}
    </>
  )
}
