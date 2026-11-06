import type { MemoryScope } from '@seti/shared'
import { Hint } from '@/components/Hint'
import { cn } from '@/lib/utils'
import { bytesLabel } from '@/panels/resources/format'

const SCOPE_LABEL: Record<MemoryScope['kind'], string> = {
  agent: 'Agent',
  side_chat: 'Side chat',
  shell: 'Shell command',
  terminal: 'Terminal',
}

/** What a scope of the agent uses against its cap, with the throttle point marked on the bar. */
export function MemoryRow({ scope }: { scope: MemoryScope }) {
  const percent = Math.min(100, (100 * scope.current_bytes) / scope.max_bytes)
  const throttles = scope.high_bytes < scope.max_bytes
  const over = throttles && scope.current_bytes > scope.high_bytes
  const label = `${SCOPE_LABEL[scope.kind]}: ${bytesLabel(scope.current_bytes)} of its ${bytesLabel(scope.max_bytes)} cap`
  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-medium">{SCOPE_LABEL[scope.kind]}</span>
        <span className="tabular-nums">
          {bytesLabel(scope.current_bytes)} of {bytesLabel(scope.max_bytes)}
        </span>
        {scope.swap_bytes > 0 && (
          <span className="text-muted-foreground tabular-nums">+{bytesLabel(scope.swap_bytes)} swapped</span>
        )}
        {over && <span className="text-warning-text">throttled</span>}
        {scope.oom_kills > 0 && (
          <span className="text-destructive">
            {scope.oom_kills} {scope.oom_kills === 1 ? 'process' : 'processes'} stopped at the cap
          </span>
        )}
      </div>
      <Hint
        text={
          throttles
            ? `Slowed down above ${bytesLabel(scope.high_bytes)}, a process stopped above ${bytesLabel(scope.max_bytes)}`
            : `A process stopped above ${bytesLabel(scope.max_bytes)}`
        }
      >
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          className="relative h-1.5 w-full bg-muted"
        >
          <div
            className={cn('h-full', over ? 'bg-warning-fill' : 'bg-primary')}
            style={{ width: `${String(percent)}%` }}
          />
          {throttles && (
            <span
              aria-hidden="true"
              className="absolute inset-y-0 w-px bg-foreground/60"
              style={{ left: `${String((100 * scope.high_bytes) / scope.max_bytes)}%` }}
            />
          )}
        </div>
      </Hint>
    </li>
  )
}
