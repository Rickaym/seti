import type { ClaudeSession, ClaudeSessionDetail, Repo } from '@seti/shared'
import { AlertTriangle, ExternalLink, Import } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ImportFields } from '@/panels/tasks/import/ImportFields'
import { draftIssue, prLabel, type ImportDraft } from '@/panels/tasks/import/drafts'
import { Tag } from '@/panels/tasks/pr-badges'

const when = (iso: string | null) =>
  iso === null ? 'unknown' : new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function fileSize(bytes: number | null): string {
  if (bytes === null) {
    return 'unknown'
  }
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${String(Math.ceil(bytes / 1024))} KB`
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-xs">{children}</dd>
    </div>
  )
}

function PrLink({ url, tag }: { url: string; tag: string }) {
  return (
    <li className="flex items-center gap-2 text-xs">
      <a className="text-primary hover:underline" href={url} target="_blank" rel="noreferrer">
        {prLabel(url)}
      </a>
      <Tag tone="muted">{tag}</Tag>
      <ExternalLink className="size-3 text-muted-foreground" />
    </li>
  )
}

function FoundPrs({ row, detail }: { row: ClaudeSession; detail: ClaudeSessionDetail }) {
  const suggested = row.suggested_pr
  const listed = new Set([...detail.created_prs, ...detail.mentioned_prs])
  if (listed.size === 0 && !suggested) {
    return <p className="text-xs text-muted-foreground">No pull requests found in this session.</p>
  }
  return (
    <ul className="space-y-1">
      {detail.created_prs.map((url) => (
        <PrLink key={url} url={url} tag="created here" />
      ))}
      {suggested && !listed.has(suggested.url) && <PrLink url={suggested.url} tag="open on branch" />}
      {detail.mentioned_prs.map((url) => (
        <PrLink key={url} url={url} tag="mentioned" />
      ))}
    </ul>
  )
}

export function SessionDetail({
  row,
  detail,
  draft,
  repos,
  importing,
  onChange,
  onImport,
}: {
  row: ClaudeSession
  detail: ClaudeSessionDetail | undefined
  draft: ImportDraft | undefined
  repos: readonly Repo[]
  importing: boolean
  onChange: (draft: ImportDraft) => void
  onImport: () => void
}) {
  const issue = draftIssue(row, draft)
  return (
    <section aria-label="Session detail" className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold break-words">{row.title}</h3>
          <p className="font-mono text-2xs break-all text-muted-foreground">{row.cwd ?? 'unknown folder'}</p>
          {!row.cwd_exists && (
            <p className="flex items-center gap-1 text-xs text-warning-text">
              <AlertTriangle className="size-3.5 shrink-0" />
              This folder does not exist here. Pick a registered repo to continue the session in.
            </p>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-3">
          <Stat label="Messages">{detail ? detail.message_count : '...'}</Stat>
          <Stat label="Size">{fileSize(row.size)}</Stat>
          <Stat label="Started">{when(detail ? detail.first_at : row.created_at)}</Stat>
          <Stat label="Last message">{when(detail ? detail.last_at : row.last_modified)}</Stat>
        </dl>
        <div className="space-y-1.5">
          <div className="text-xs font-medium">Pull requests</div>
          {detail ? (
            <FoundPrs row={row} detail={detail} />
          ) : (
            <p className="text-xs text-muted-foreground">Reading...</p>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 border-t border-border pt-4 *:min-w-0">
          <ImportFields row={row} detail={detail} draft={draft} repos={repos} onChange={onChange} />
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border px-4 py-3">
        {issue !== null && <span className="text-xs text-muted-foreground">{issue}</span>}
        <Button
          size="sm"
          aria-label={importing ? undefined : 'Import this session'}
          disabled={issue !== null || importing}
          onClick={onImport}
        >
          <Import />
          {importing ? 'Importing...' : 'Import'}
        </Button>
      </div>
    </section>
  )
}
