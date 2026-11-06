import type { ClaudeSession, ClaudeSessionDetail, Repo } from '@seti/shared'
import { X } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/lib/time'
import { ImportFields } from '@/panels/tasks/import/ImportFields'
import { draftIssue, type Drafts, type ImportDraft } from '@/panels/tasks/import/drafts'

export function ReviewStep({
  rows,
  details,
  drafts,
  errors,
  repos,
  onChange,
  onRemove,
}: {
  rows: readonly ClaudeSession[]
  details: Readonly<Record<string, ClaudeSessionDetail>>
  drafts: Drafts
  errors: Readonly<Record<string, string>>
  repos: readonly Repo[]
  onChange: (id: string, draft: ImportDraft) => void
  onRemove: (id: string) => void
}) {
  return (
    <ol aria-label="Sessions to import" className="space-y-3 p-4">
      {rows.map((row) => {
        const problem = errors[row.id] ?? draftIssue(row, drafts[row.id])
        return (
          <li key={row.id} aria-label={row.title} className="border border-border">
            <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
              <span className="min-w-0 truncate text-xs font-medium">{row.title}</span>
              <span className="shrink-0 text-2xs text-muted-foreground">
                {[row.repo_slug ?? row.cwd, relativeTime(row.last_modified)]
                  .filter((part) => part !== null)
                  .join(' | ')}
              </span>
              <Hint text="Leave this session out of the import" side="left">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto"
                  aria-label={`Remove ${row.title}`}
                  onClick={() => {
                    onRemove(row.id)
                  }}
                >
                  <X />
                </Button>
              </Hint>
            </div>
            <div className="grid grid-cols-1 gap-3 p-3 *:min-w-0 sm:grid-cols-2">
              <ImportFields
                row={row}
                detail={details[row.id]}
                draft={drafts[row.id]}
                repos={repos}
                onChange={(draft) => {
                  onChange(row.id, draft)
                }}
              />
              {problem !== null && <p className="col-span-full text-xs text-destructive">{problem}</p>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
