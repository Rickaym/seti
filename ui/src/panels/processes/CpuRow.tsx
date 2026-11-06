import type { CpuScope } from '@seti/shared'
import { Hint } from '@/components/Hint'
import { cpuFill, cpuUseLabel, throttleHint } from './cpu-use'

const SCOPE_LABEL: Record<CpuScope['kind'], string> = {
  agent: 'Agent',
  side_chat: 'Side chat',
  shell: 'Shell command',
  terminal: 'Terminal',
}

/** What a scope of the agent uses of the CPU against its cap, and a calm note when held at it. */
export function CpuRow({ scope }: { scope: CpuScope }) {
  const fill = cpuFill(scope)
  const held = throttleHint(scope)
  const use = cpuUseLabel(scope)
  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-medium">{SCOPE_LABEL[scope.kind]}</span>
        <span className="tabular-nums">{use}</span>
        {held !== null && (
          <Hint text={held.detail}>
            <span className="text-muted-foreground">{held.label}</span>
          </Hint>
        )}
      </div>
      {fill !== null && (
        <div
          role="meter"
          aria-label={`${SCOPE_LABEL[scope.kind]} CPU: ${use}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fill)}
          className="h-1.5 w-full bg-muted"
        >
          <div className="h-full bg-primary" style={{ width: `${String(fill)}%` }} />
        </div>
      )}
    </li>
  )
}
