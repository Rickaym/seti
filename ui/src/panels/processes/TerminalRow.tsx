import type { TerminalStatus } from '@seti/shared'
import { cn } from '@/lib/utils'
import { ageLabel } from '@/panels/resources/format'
import { StopButton } from './StopButton'

const PILL = 'shrink-0 px-1.5 py-0.5 text-2xs font-semibold uppercase'

const secondsSince = (at: string, now: number) => Math.max(0, (now - Date.parse(at)) / 1000)

/** A terminal the user opened in the agent's directory: whether a window shows it, and a stop. */
export function TerminalRow({
  terminal,
  now,
  onStop,
}: {
  terminal: TerminalStatus
  now: number
  onStop: () => Promise<void>
}) {
  const endsIn = terminal.ends_at === null ? null : Math.max(0, (Date.parse(terminal.ends_at) - now) / 1000)
  return (
    <div data-testid="terminal-row" className="flex items-start gap-2 border border-border p-2">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className={cn(PILL, terminal.attached ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
            {terminal.attached ? 'open' : 'closed'}
          </span>
          <span className="min-w-0 truncate text-xs font-medium">Terminal</span>
        </div>
        <code className="block truncate font-mono text-2xs text-muted-foreground" title={terminal.cwd}>
          {terminal.shell} -l in {terminal.cwd}
        </code>
        <div className="flex flex-wrap gap-x-3 text-2xs text-muted-foreground">
          <span className="tabular-nums">{ageLabel(secondsSince(terminal.started_at, now))}</span>
          <span>{terminal.sandboxed ? 'sandbox' : 'host'}</span>
          <span className="tabular-nums">pid {terminal.pid}</span>
          {endsIn !== null && <span className="tabular-nums">ends in {ageLabel(endsIn)}</span>}
        </div>
      </div>
      <StopButton label="Stop terminal" hint="End the terminal's shell and everything it started" onStop={onStop} />
    </div>
  )
}
