import { unresolvedThreadsText, type CiState } from '@seti/shared'
import { CircleCheck, CircleDot, CircleMinus, CircleX, MessageSquare, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import { cn } from '@/lib/utils'

type Tone = 'success' | 'failure' | 'warning' | 'muted'

const TONE: Record<Tone, string> = {
  success: 'bg-success/20 text-foreground',
  failure: 'bg-destructive/20 text-destructive',
  warning: 'bg-warning/25 text-foreground',
  muted: 'bg-muted text-muted-foreground',
}

export function Tag({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={cn('shrink-0 px-1.5 py-0.5 text-2xs font-semibold uppercase', TONE[tone])}>{children}</span>
}

const CI: Record<CiState, { tone: Tone; label: string }> = {
  success: { tone: 'success', label: 'ci pass' },
  failure: { tone: 'failure', label: 'ci fail' },
  pending: { tone: 'warning', label: 'ci running' },
  neutral: { tone: 'muted', label: 'ci neutral' },
}

export function CiBadge({ state }: { state: CiState | null }) {
  return state === null ? null : <Tag tone={CI[state].tone}>{CI[state].label}</Tag>
}

/** Unresolved review threads as an icon and count beside the CI state; nothing when none are. */
export function ThreadsBadge({ count, bare = false }: { count: number; bare?: boolean }) {
  const hint = unresolvedThreadsText(count)
  if (hint === null) {
    return null
  }
  const badge = (
    <span
      role="img"
      aria-label={hint}
      className="flex shrink-0 items-center gap-0.5 text-2xs font-semibold text-warning-text tabular-nums"
    >
      <MessageSquare className="size-3" aria-hidden />
      {count}
    </span>
  )
  return bare ? badge : <Hint text={hint}>{badge}</Hint>
}

const CHECK_ICON: Record<CiState, { icon: LucideIcon; className: string }> = {
  success: { icon: CircleCheck, className: 'text-success' },
  failure: { icon: CircleX, className: 'text-destructive' },
  pending: { icon: CircleDot, className: 'text-warning-text animate-pulse' },
  neutral: { icon: CircleMinus, className: 'text-muted-foreground' },
}

export function CheckIcon({ state }: { state: CiState }) {
  const { icon: Icon, className } = CHECK_ICON[state]
  return <Icon className={cn('size-3.5 shrink-0', className)} aria-label={state} />
}
