import type { ClaudeSession } from '@seti/shared'
import { AlertTriangle, GitBranch, GitPullRequest } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { CiBadge, ThreadsBadge } from '@/panels/tasks/pr-badges'

function SessionRow({
  row,
  focused,
  checked,
  canCheck,
  onFocus,
  onCheck,
}: {
  row: ClaudeSession
  focused: boolean
  checked: boolean
  canCheck: boolean
  onFocus: () => void
  onCheck: (checked: boolean) => void
}) {
  return (
    <li
      data-session-id={row.id}
      className={cn('flex items-start gap-2.5 border-b border-border px-3 py-2', focused && 'bg-accent')}
    >
      <Checkbox
        className="mt-0.5 bg-background"
        aria-label={`Select ${row.title}`}
        checked={checked}
        disabled={!checked && !canCheck}
        onCheckedChange={(value) => {
          onCheck(value === true)
        }}
      />
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onFocus}>
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{row.title}</span>
          <span className="ml-auto shrink-0 text-2xs text-muted-foreground">{relativeTime(row.last_modified)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-2xs text-muted-foreground">
          <span className={cn('truncate', row.repo_slug !== null && 'text-foreground')}>
            {row.repo_slug ?? row.cwd ?? 'unknown folder'}
          </span>
          {row.git_branch !== null && row.git_branch !== 'HEAD' && (
            <span className="flex min-w-0 items-center gap-0.5">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate">{row.git_branch}</span>
            </span>
          )}
          {row.suggested_pr && (
            <span className="flex shrink-0 items-center gap-1 text-primary" title={row.suggested_pr.title}>
              <GitPullRequest className="size-3" />#{row.suggested_pr.number}
              <CiBadge state={row.suggested_pr.ci} />
              <ThreadsBadge count={row.suggested_pr.unresolved_threads} />
            </span>
          )}
          {!row.cwd_exists && (
            <span className="flex shrink-0 items-center gap-0.5 text-warning-text" title={row.cwd ?? undefined}>
              <AlertTriangle className="size-3" />
              folder missing
            </span>
          )}
        </div>
      </button>
    </li>
  )
}

export function SessionList({
  rows,
  focusedId,
  checkedIds,
  canCheckMore,
  onFocus,
  onCheck,
}: {
  rows: readonly ClaudeSession[]
  focusedId: string | null
  checkedIds: ReadonlySet<string>
  canCheckMore: boolean
  onFocus: (row: ClaudeSession) => void
  onCheck: (row: ClaudeSession, checked: boolean) => void
}) {
  return (
    <ul aria-label="Sessions">
      {rows.map((row) => (
        <SessionRow
          key={row.id}
          row={row}
          focused={row.id === focusedId}
          checked={checkedIds.has(row.id)}
          canCheck={canCheckMore}
          onFocus={() => {
            onFocus(row)
          }}
          onCheck={(checked) => {
            onCheck(row, checked)
          }}
        />
      ))}
    </ul>
  )
}
