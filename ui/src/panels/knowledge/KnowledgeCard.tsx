import {
  KNOWLEDGE_KIND_LABELS,
  type ApproveKnowledgeInput,
  type KnowledgeFieldsInput,
  type KnowledgeNote,
  type KnowledgeSource,
} from '@seti/shared'
import { Archive, Check, FileText, Link, ListChecks, Pencil, Save, SquareTerminal, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { apiPost, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { RelativeTime } from '@/components/RelativeTime'
import { Button } from '@/components/ui/button'
import { KnowledgeForm } from '@/panels/knowledge/KnowledgeForm'

const SOURCE_ICONS = { path: FileText, url: Link, command: SquareTerminal } as const

function Source({ source }: { source: KnowledgeSource }) {
  const Icon = SOURCE_ICONS[source.kind]
  return (
    <li className="flex min-w-0 items-start gap-1.5">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label={source.kind} />
      <span className="min-w-0 font-mono text-2xs break-all">{source.ref}</span>
    </li>
  )
}

function proposerText(note: KnowledgeNote): string {
  switch (note.proposer) {
    case 'agent':
      return note.proposer_title ?? 'an agent'
    case 'ea':
      return 'the EA'
    case 'user':
      return 'you'
  }
}

function Meta({ note }: { note: KnowledgeNote }) {
  return (
    <p className="text-2xs text-muted-foreground">
      Proposed by {proposerText(note)} <RelativeTime iso={note.created_at} />
      {note.last_verified_at !== null && (
        <>
          {' '}
          / checked <RelativeTime iso={note.last_verified_at} />, {note.verified_count} passed
        </>
      )}
    </p>
  )
}

function Action({
  label,
  hint,
  onClick,
  children,
}: {
  label: string
  hint: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Hint text={hint}>
      <Button size="sm" variant={label === 'Approve' ? 'default' : 'outline'} onClick={onClick}>
        {children}
        {label}
      </Button>
    </Hint>
  )
}

/** One note with what the user may do to it in its state; edits and approval are the user's alone. */
export function KnowledgeCard({ note, onChanged }: { note: KnowledgeNote; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const act = async (run: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await run()
      toast.success(done)
      setEditing(false)
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const approve = (edit?: KnowledgeFieldsInput) => {
    const body: ApproveKnowledgeInput = edit === undefined ? {} : { edit }
    void act(async () => apiPost(`/knowledge/${note.id}/approve`, body), 'Approved; agents see it now')
  }
  const reject = () => {
    void act(
      async () => apiPost(`/knowledge/${note.id}/reject`, {}),
      note.status === 'proposed' ? 'Rejected' : 'Retired',
    )
  }
  const save = (fields: KnowledgeFieldsInput) => {
    void act(async () => apiPut(`/knowledge/${note.id}`, fields), 'Saved')
  }
  const proposal = note.status === 'proposed'
  return (
    <article aria-label={`Note: ${note.title}`} className="space-y-2 border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
        <span className="border border-border px-1.5 py-0.5 font-semibold uppercase">
          {KNOWLEDGE_KIND_LABELS[note.kind]}
        </span>
        <span>{note.repo_slug ?? 'All repos'}</span>
        {note.corrects_id !== null && <span>Corrects an earlier note</span>}
      </div>
      {editing ? (
        <KnowledgeForm
          note={note}
          busy={busy}
          save={
            proposal ? (
              <>
                <Check />
                Approve
              </>
            ) : (
              <>
                <Save />
                Save
              </>
            )
          }
          onSave={(fields) => {
            if (proposal) {
              approve(fields)
            } else {
              save(fields)
            }
          }}
          onCancel={() => {
            setEditing(false)
          }}
        />
      ) : (
        <>
          <h3 className="text-sm font-semibold wrap-anywhere">{note.title}</h3>
          <p className="text-sm whitespace-pre-wrap wrap-anywhere">{note.body}</p>
          <p className="flex items-start gap-1.5 text-xs">
            <ListChecks className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="wrap-anywhere">
              <span className="font-medium">Verify:</span> {note.verify}
            </span>
          </p>
          {note.sources.length > 0 && (
            <ul aria-label="Sources" className="space-y-1">
              {note.sources.map((source) => (
                <Source key={`${source.kind}:${source.ref}`} source={source} />
              ))}
            </ul>
          )}
          {note.status_reason !== null && <p className="text-xs text-muted-foreground">{note.status_reason}</p>}
          <Meta note={note} />
          <div className="flex flex-wrap gap-2 pt-1">
            {note.status !== 'approved' && (
              <Action
                label="Approve"
                hint="Agents see its title in their instructions"
                onClick={() => {
                  approve()
                }}
              >
                <Check />
              </Action>
            )}
            <Action
              label="Edit"
              hint={proposal ? 'Edit, then approve' : 'Edit what agents read'}
              onClick={() => {
                setEditing(true)
              }}
            >
              <Pencil />
            </Action>
            <Action
              label={proposal ? 'Reject' : 'Retire'}
              hint={proposal ? 'No agent sees it' : 'Agents stop seeing it'}
              onClick={reject}
            >
              {proposal ? <X /> : <Archive />}
            </Action>
          </div>
        </>
      )}
    </article>
  )
}
