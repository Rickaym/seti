import { changedKeys, type Revision, type RevisionObjectType } from '@seti/shared'
import { Bot, StickyNote, Undo2, User } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { ACTOR_STYLE, exactTime } from '@/panels/audit/format'
import { FieldChange } from './FieldChange'
import { fieldLabel } from './format'

function ActorBadge({ revision }: { revision: Revision }) {
  const Icon = revision.actor === 'agent' ? Bot : User
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-2xs font-semibold uppercase',
        ACTOR_STYLE[revision.actor],
      )}
    >
      <Icon className="size-3" aria-hidden />
      {revision.actor === 'agent' ? 'agent' : 'you'}
    </span>
  )
}

function headline(revision: Revision, fields: readonly string[]): string {
  switch (revision.kind) {
    case 'created':
      return 'Created'
    case 'note':
      return 'Note'
    case 'updated':
      return `Changed ${fields.map((f) => fieldLabel(f).toLowerCase()).join(', ')}`
  }
}

function RevisionItem({
  revision,
  now,
  onRevert,
}: {
  revision: Revision
  now: number
  onRevert: (revision: Revision, fields: readonly string[]) => void
}) {
  const fields = changedKeys(revision.before, revision.after)
  return (
    <li className="space-y-2 border-b border-border px-3 py-2.5 last:border-b-0" data-revision-id={revision.id}>
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <ActorBadge revision={revision} />
        <span className="min-w-0 flex-1 truncate font-medium" title={headline(revision, fields)}>
          {headline(revision, fields)}
        </span>
        <span className="shrink-0 text-muted-foreground tabular-nums" title={exactTime(revision.at)}>
          #{revision.id} | {relativeTime(revision.at, now)}
        </span>
        {revision.kind === 'updated' && (
          <Button
            size="xs"
            variant="outline"
            aria-label={`Revert revision ${String(revision.id)}`}
            onClick={() => {
              onRevert(revision, fields)
            }}
          >
            <Undo2 aria-hidden />
            Revert
          </Button>
        )}
      </div>
      {revision.task_id !== null && (
        <div className="truncate text-2xs text-muted-foreground">
          from agent{' '}
          <a href={`#agents/${revision.task_id}`} className="text-primary hover:underline">
            {revision.task_title ?? revision.task_id}
          </a>
        </div>
      )}
      {revision.reason !== null && (
        <p
          className={cn(
            'flex gap-1.5 border-l-2 border-actor-agent/50 pl-2 text-xs',
            revision.kind !== 'note' && 'text-muted-foreground',
          )}
        >
          {revision.kind === 'note' && <StickyNote className="mt-0.5 size-3 shrink-0 text-actor-agent" aria-hidden />}
          <span className="min-w-0 break-words whitespace-pre-wrap">{revision.reason}</span>
        </p>
      )}
      {revision.kind === 'updated' &&
        fields.map((field) => (
          <FieldChange key={field} field={field} before={revision.before?.[field]} after={revision.after?.[field]} />
        ))}
    </li>
  )
}

export function RevisionHistory({
  objectType,
  objectId,
  version = 0,
  discardsEdits = false,
  onReverted,
}: {
  objectType: RevisionObjectType
  objectId: string
  /** Bump to reload after the object changed elsewhere. */
  version?: number
  /** The editor has unsaved edits that a revert replaces. */
  discardsEdits?: boolean
  onReverted: () => void
}) {
  const confirm = useConfirm()
  const [revisions, setRevisions] = useState<Revision[] | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const query = `object_type=${objectType}&object_id=${encodeURIComponent(objectId)}`
    apiGet<Revision[]>(`/revisions?${query}`)
      .then((rows) => {
        setRevisions(rows)
        setNow(Date.now())
        setError('')
      })
      .catch((e: unknown) => {
        setError(errorText(e))
      })
  }, [objectType, objectId, version, reload])

  const revert = async (revision: Revision, fields: readonly string[]) => {
    const names = fields.map((f) => fieldLabel(f).toLowerCase()).join(', ')
    const extra = discardsEdits ? ' Your unsaved edits in the editor are discarded.' : ''
    const message = `Set ${names} back to the value before revision #${String(revision.id)}? The revert is recorded as a new revision.${extra}`
    if (!(await confirm({ title: 'Revert change', message, confirmLabel: 'Revert' }))) {
      return
    }
    try {
      await apiPost<Revision>(`/revisions/${String(revision.id)}/revert`, {})
      toast.success('Reverted')
      setReload((v) => v + 1)
      onReverted()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  if (error !== '') {
    return <p className="px-3 py-2 text-xs text-destructive">{error}</p>
  }
  if (revisions === null) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">Loading...</p>
  }
  if (revisions.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">No changes recorded yet.</p>
  }
  return (
    <ol aria-label="Revisions">
      {revisions.map((revision) => (
        <RevisionItem
          key={revision.id}
          revision={revision}
          now={now}
          onRevert={(r, fields) => void revert(r, fields)}
        />
      ))}
    </ol>
  )
}
