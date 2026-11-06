import type { Task, TaskDisplayStatus } from '@seti/shared'
import { classifyFailure, INTERRUPTED } from '@/lib/failure'

const LABELS: Partial<Record<TaskDisplayStatus, string>> = { asking: 'asks you', blocked: 'waits on you' }

/** How a status reads on pills, glyph names and the legend. */
export const statusLabel = (status: TaskDisplayStatus): string => LABELS[status] ?? status

/** Success and warning lean toward the text colour so every glyph keeps 3:1 on its row. */
export const GLYPH_COLOUR: Readonly<Record<TaskDisplayStatus, string>> = {
  running: 'text-primary',
  idle: 'text-[color-mix(in_srgb,var(--success)_70%,var(--foreground))]',
  complete: 'text-[color-mix(in_srgb,var(--success)_70%,var(--foreground))]',
  error: 'text-destructive',
  stopped: 'text-muted-foreground',
  interrupted: 'text-[color-mix(in_srgb,var(--warning)_60%,var(--foreground))]',
  asking: 'text-[color-mix(in_srgb,var(--warning)_60%,var(--foreground))]',
  blocked: 'text-[color-mix(in_srgb,var(--warning)_60%,var(--foreground))]',
}

export function subagentsHint(subagents: number): string | undefined {
  if (subagents === 0) {
    return undefined
  }
  return `${String(subagents)} ${subagents === 1 ? 'subagent' : 'subagents'} running`
}

/** The status marker's tooltip, which an agent row accent takes over while it hides the marker. */
export function statusLightTitle(status: TaskDisplayStatus, subagents: number): string {
  const hint = subagentsHint(subagents)
  const label = statusLabel(status)
  return hint === undefined ? label : `${label}: ${hint}`
}

/**
 * The line an agent's row shows after its title: why it waits on the user or why its turn failed,
 * else the status line it set itself.
 */
export function reasonLine(
  task: Pick<Task, 'blocked' | 'last_error' | 'status_line'>,
  status: TaskDisplayStatus,
): string | null {
  if (task.blocked !== null) {
    return task.blocked
  }
  if (status === 'error') {
    return classifyFailure(task.last_error ?? '').title
  }
  return status === 'interrupted' ? INTERRUPTED.title : task.status_line
}
