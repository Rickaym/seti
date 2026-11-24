import { SETTINGS_DOC_GROUPS, type SettingsDoc, type SettingsImportPreview } from '@seti/shared'
import { Download, Pencil, PenLine, Search, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, errorText } from '@/api'
import { CopyIconButton } from '@/components/CopyButton'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { HighlightedCode } from '@/components/highlight/HighlightedCode'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RevisionHistory } from '@/panels/revisions/RevisionHistory'
import { SettingsBody, SettingsCard, SettingsHeader } from '../layout'
import { useMovedCard } from '../use-moved-card'
import { ImportDialog } from './ImportDialog'
import { JsonEditor } from './JsonEditor'
import { SectionReset } from './SectionReset'
import type { JsonSchema } from './json-complete'
import { asJson, docSections, exportName, shownSections, type DocFilter } from './settings-json'

const ALL = 'all'

const GROUP_LABELS: Record<string, string> = {
  app: 'App',
  agents: 'Agents',
  capabilities: 'Capabilities',
  security: 'Security',
  mods: 'Mods',
}

/** Saves the document as a file, which a phone offers to keep or share. */
function exportDoc(doc: SettingsDoc, modified: boolean): void {
  const url = URL.createObjectURL(new Blob([asJson(doc)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = exportName(new Date(), modified)
  link.click()
  URL.revokeObjectURL(url)
}

function Filters({ filter, onFilter }: { filter: DocFilter; onFilter: (filter: DocFilter) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-0 flex-1 basis-56">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search settings"
          placeholder="Search keys and values"
          className="h-7 pl-8"
          value={filter.query}
          onChange={(e) => {
            onFilter({ ...filter, query: e.target.value })
          }}
        />
      </div>
      <Select
        value={filter.group ?? ALL}
        onValueChange={(value) => {
          onFilter({ ...filter, group: value === ALL ? null : value })
        }}
      >
        <SelectTrigger aria-label="Group" size="sm" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All groups</SelectItem>
          {SETTINGS_DOC_GROUPS.map((value) => (
            <SelectItem key={value} value={value}>
              {GROUP_LABELS[value] ?? value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ToggleButton
        pressed={filter.modified}
        onPressedChange={(modified) => {
          onFilter({ ...filter, modified })
        }}
        icon={PenLine}
        label="Modified"
        hint="Show only settings that differ from their default"
      />
    </div>
  )
}

/** How many of a section's settings differ from their default, beside its title. */
function ModifiedMark({ count }: { count: number }) {
  if (count === 0) {
    return null
  }
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <span aria-hidden className="size-1.5 rounded-full bg-primary" />
      {count} modified
    </span>
  )
}

function Sections({
  doc,
  defaults,
  filter,
  onSaved,
}: {
  doc: SettingsDoc
  defaults: SettingsDoc | null
  filter: DocFilter
  onSaved: () => void
}) {
  const sections = useMemo(() => docSections(doc, defaults), [doc, defaults])
  const shown = shownSections(sections, filter)
  if (shown.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {filter.modified ? 'No setting differs from its default.' : 'No setting matches.'}
      </p>
    )
  }
  return (
    <>
      {shown.map((section) => {
        const text = asJson(section.value)
        return (
          <SettingsCard
            key={section.path}
            id={`json-${section.path}`}
            title={section.path}
            actions={
              <>
                <ModifiedMark count={section.modified} />
                <SectionReset doc={doc} section={section} onSaved={onSaved} />
                <CopyIconButton text={text} label={`Copy ${section.path}`} />
              </>
            }
          >
            <pre className="px-3 py-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
              <HighlightedCode code={text} language="json" />
            </pre>
          </SettingsCard>
        )
      })}
    </>
  )
}

function History({ version, onReverted }: { version: number; onReverted: () => void }) {
  return (
    <SettingsCard id="json-history" title="History">
      <RevisionHistory objectType="settings" objectId="settings-doc" version={version} onReverted={onReverted} />
    </SettingsCard>
  )
}

function useSettingsDoc() {
  const [doc, setDoc] = useState<SettingsDoc | null>(null)
  const [error, setError] = useState('')
  const [defaults, setDefaults] = useState<SettingsDoc | null>(null)
  const [schema, setSchema] = useState<JsonSchema | null>(null)
  const [version, setVersion] = useState(0)
  const load = useCallback(() => {
    apiGet<SettingsDoc>('/settings-doc').then(
      (read) => {
        setDoc(read)
        setVersion((v) => v + 1)
      },
      (e: unknown) => {
        setError(errorText(e))
      },
    )
    apiGet<SettingsDoc>('/settings-doc/defaults').then(setDefaults, () => {
      setDefaults(null)
    })
  }, [])
  useEffect(load, [load])
  useEffect(() => {
    apiGet<JsonSchema>('/settings-doc/schema').then(setSchema, () => {
      setSchema(null)
    })
  }, [])
  return { doc, error, defaults, schema, version, load }
}

/** Saves the document, or with Modified on only what differs from the defaults, as a file. */
function exportNow(doc: SettingsDoc, modified: boolean): void {
  if (!modified) {
    exportDoc(doc, false)
    return
  }
  apiGet<SettingsDoc>('/settings-doc?only=modified').then(
    (changed) => {
      exportDoc(changed, true)
    },
    (e: unknown) => {
      toast.error(errorText(e), { duration: Infinity })
    },
  )
}

/** Reads a chosen file as JSON and asks Seti what importing it would do. */
async function readImport(chosen: File): Promise<Importing> {
  const parsed: unknown = JSON.parse(await chosen.text())
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('A settings file holds one JSON object')
  }
  const file = parsed as Record<string, unknown>
  return { file, preview: await apiPost<SettingsImportPreview>('/settings-doc/import/preview', { file }) }
}

interface Importing {
  file: Record<string, unknown>
  preview: SettingsImportPreview
}

function HeaderActions({
  doc,
  modified,
  onEdit,
  onImport,
}: {
  doc: SettingsDoc
  modified: boolean
  onEdit: () => void
  onImport: (importing: Importing) => void
}) {
  const picker = useRef<HTMLInputElement>(null)
  return (
    <>
      <CopyIconButton text={asJson(doc)} label="Copy all settings" variant="outline" />
      <Hint text={modified ? 'Save only the settings that differ from their default' : 'Save every setting as a file'}>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            exportNow(doc, modified)
          }}
        >
          <Download />
          Export
        </Button>
      </Hint>
      <input
        ref={picker}
        type="file"
        accept="application/json,.json"
        aria-label="Settings file"
        className="hidden"
        onChange={(e) => {
          const input = e.currentTarget
          const chosen = input.files?.[0]
          input.value = ''
          if (chosen !== undefined) {
            readImport(chosen).then(onImport, (err: unknown) => {
              toast.error(errorText(err), { duration: Infinity })
            })
          }
        }}
      />
      <Button size="sm" variant="outline" onClick={() => picker.current?.click()}>
        <Upload />
        Import
      </Button>
      <Button size="sm" variant="outline" onClick={onEdit}>
        <Pencil />
        Edit
      </Button>
    </>
  )
}

/** Every setting as one document: search, copy or export it; edit plain settings, with undo. */
export function SettingsJsonPage() {
  const { doc, error, defaults, schema, version, load } = useSettingsDoc()
  const [filter, setFilter] = useState<DocFilter>({ query: '', group: null, modified: false })
  const [editing, setEditing] = useState(false)
  const [importing, setImporting] = useState<Importing | null>(null)
  useMovedCard(doc !== null)
  return (
    <SettingsBody
      header={
        <SettingsHeader
          title="JSON"
          description="Every setting as one document. Secrets show only as set; security settings change on their own pages."
          actions={
            doc !== null &&
            !editing && (
              <HeaderActions
                doc={doc}
                modified={filter.modified}
                onEdit={() => {
                  setEditing(true)
                }}
                onImport={setImporting}
              />
            )
          }
        />
      }
    >
      {doc !== null && editing ? (
        <JsonEditor
          key={doc.revision}
          doc={doc}
          schema={schema}
          onClose={() => {
            setEditing(false)
          }}
          onSaved={load}
        />
      ) : (
        <div className="space-y-4">
          <Filters filter={filter} onFilter={setFilter} />
          {doc === null ? (
            <p className={error === '' ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
              {error === '' ? 'Loading...' : error}
            </p>
          ) : (
            <Sections doc={doc} defaults={defaults} filter={filter} onSaved={load} />
          )}
          <History version={version} onReverted={load} />
        </div>
      )}
      {importing !== null && (
        <ImportDialog
          file={importing.file}
          preview={importing.preview}
          onClose={() => {
            setImporting(null)
          }}
          onImported={load}
        />
      )}
    </SettingsBody>
  )
}
