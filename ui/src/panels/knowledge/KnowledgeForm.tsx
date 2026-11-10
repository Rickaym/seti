import {
  KNOWLEDGE_KIND_LABELS,
  KNOWLEDGE_KINDS,
  type KnowledgeFieldsInput,
  type KnowledgeKind,
  type KnowledgeNote,
  type KnowledgeSource,
  type Repo,
} from '@seti/shared'
import { X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { apiGet } from '@/api'
import { Field } from '@/components/crud/CrudForm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'

const COMMAND_MARK = '$ '

/** A source as one line: a URL or path as it is, a command after "$ ". */
const sourceLine = (source: KnowledgeSource) =>
  source.kind === 'command' ? `${COMMAND_MARK}${source.ref}` : source.ref

function sourceOf(line: string): KnowledgeSource {
  if (line.startsWith(COMMAND_MARK)) {
    return { kind: 'command', ref: line.slice(COMMAND_MARK.length).trim() }
  }
  return { kind: /^https?:\/\//.test(line) ? 'url' : 'path', ref: line }
}

const isKind = (value: string): value is KnowledgeKind => (KNOWLEDGE_KINDS as readonly string[]).includes(value)

interface Draft {
  kind: KnowledgeKind
  title: string
  body: string
  verify: string
  sources: string
  repo: string
}

const draftOf = (note: KnowledgeNote): Draft => ({
  kind: note.kind,
  title: note.title,
  body: note.body,
  verify: note.verify,
  sources: note.sources.map(sourceLine).join('\n'),
  repo: note.repo_id ?? '',
})

const fieldsOf = (draft: Draft): KnowledgeFieldsInput => ({
  kind: draft.kind,
  title: draft.title,
  body: draft.body,
  verify: draft.verify,
  sources: draft.sources
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map(sourceOf),
  repo_id: draft.repo === '' ? null : draft.repo,
})

/** The user's edit of a note; `save` names what saving does, such as Approve for a proposal. */
export function KnowledgeForm({
  note,
  save,
  busy,
  onSave,
  onCancel,
}: {
  note: KnowledgeNote
  save: ReactNode
  busy: boolean
  onSave: (fields: KnowledgeFieldsInput) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(() => draftOf(note))
  const [repos, setRepos] = useState<Repo[]>([])
  useEffect(() => {
    apiGet<Repo[]>('/repos')
      .then(setRepos)
      .catch(() => {
        setRepos([])
      })
  }, [])
  const set = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }))
  }
  const ready = draft.title.trim() !== '' && draft.body.trim() !== '' && draft.verify.trim() !== ''
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(fieldsOf(draft))
      }}
    >
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <Field label="Kind">
          <NativeSelect
            aria-label="Kind"
            className="w-full"
            value={draft.kind}
            onChange={(event) => {
              const kind = event.target.value
              if (isKind(kind)) {
                set({ kind })
              }
            }}
          >
            {KNOWLEDGE_KINDS.map((kind) => (
              <NativeSelectOption key={kind} value={kind}>
                {KNOWLEDGE_KIND_LABELS[kind]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Repo">
          <NativeSelect
            aria-label="Repo"
            className="w-full"
            value={draft.repo}
            onChange={(event) => {
              set({ repo: event.target.value })
            }}
          >
            <NativeSelectOption value="">All repos</NativeSelectOption>
            {repos.map((repo) => (
              <NativeSelectOption key={repo.id} value={repo.id}>
                {repo.slug}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Field label="Title">
        <Input
          aria-label="Title"
          value={draft.title}
          onChange={(event) => {
            set({ title: event.target.value })
          }}
        />
      </Field>
      <Field label="Note">
        <Textarea
          aria-label="Note"
          rows={5}
          value={draft.body}
          onChange={(event) => {
            set({ body: event.target.value })
          }}
        />
      </Field>
      <Field label="Verify step">
        <Input
          aria-label="Verify step"
          value={draft.verify}
          onChange={(event) => {
            set({ verify: event.target.value })
          }}
        />
      </Field>
      <Field label="Sources, one per line; a command after $">
        <Textarea
          aria-label="Sources"
          rows={3}
          value={draft.sources}
          onChange={(event) => {
            set({ sources: event.target.value })
          }}
        />
      </Field>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          <X />
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!ready || busy}>
          {save}
        </Button>
      </div>
    </form>
  )
}
