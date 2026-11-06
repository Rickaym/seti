import type { ClaudeSession, ClaudeSessionDetail, Repo } from '@seti/shared'
import { Field } from '@/components/crud/CrudForm'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { draftPrs, prOptions, type ImportDraft } from '@/panels/tasks/import/drafts'

const SESSION_DIR = '__session__'

interface FieldsProps {
  row: ClaudeSession
  detail: ClaudeSessionDetail | undefined
  draft: ImportDraft | undefined
  repos: readonly Repo[]
  onChange: (draft: ImportDraft) => void
}

function LocationSelect({ row, draft, repos, onChange }: Omit<FieldsProps, 'detail'>) {
  const value = draft?.repoId ?? (row.cwd_exists ? SESSION_DIR : '')
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const rest = { ...draft }
        delete rest.repoId
        onChange(next === SESSION_DIR ? rest : { ...rest, repoId: next })
      }}
    >
      <SelectTrigger aria-label="Continue in" className="w-full min-w-0 overflow-hidden">
        <SelectValue placeholder="Pick a repo" />
      </SelectTrigger>
      <SelectContent>
        {row.cwd_exists && (
          <SelectItem value={SESSION_DIR}>
            {row.repo_slug === null ? 'Session folder' : `${row.repo_slug} (session folder)`}
          </SelectItem>
        )}
        {repos
          .filter((repo) => !row.cwd_exists || repo.id !== row.repo_id)
          .map((repo) => (
            <SelectItem key={repo.id} value={repo.id}>
              {repo.slug}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  )
}

function PrChecklist({ row, detail, draft, onChange }: Omit<FieldsProps, 'repos'>) {
  const chosen = new Set(draftPrs(detail, draft))
  const options = prOptions(row, detail)
  if (detail === undefined) {
    return <p className="text-xs text-muted-foreground">Finding PRs...</p>
  }
  if (options.length === 0) {
    return <p className="text-xs text-muted-foreground">No pull requests found in this session.</p>
  }
  const toggle = (url: string, on: boolean) => {
    onChange({ ...draft, prs: options.map((o) => o.url).filter((u) => (u === url ? on : chosen.has(u))) })
  }
  return (
    <ul className="grid gap-1.5">
      {options.map((option) => (
        <li key={option.url} className="flex min-w-0 items-center gap-2 text-xs">
          <Checkbox
            id={`pr-${row.id}-${option.url}`}
            checked={chosen.has(option.url)}
            onCheckedChange={(next) => {
              toggle(option.url, next === true)
            }}
          />
          <label htmlFor={`pr-${row.id}-${option.url}`} className="min-w-0 truncate" title={option.url}>
            {option.label}
          </label>
        </li>
      ))}
    </ul>
  )
}

export function ImportFields(props: FieldsProps) {
  const { row, draft, onChange } = props
  return (
    <>
      <Field label="Agent title" full>
        <Input
          aria-label="Agent title"
          value={draft?.title ?? ''}
          placeholder={row.title}
          onChange={(e) => {
            onChange({ ...draft, title: e.target.value })
          }}
        />
      </Field>
      <Field label="Continue in">
        <LocationSelect {...props} />
      </Field>
      <Field label="Pull requests">
        <div role="group" aria-label="Pull requests">
          <PrChecklist {...props} />
        </div>
      </Field>
    </>
  )
}
