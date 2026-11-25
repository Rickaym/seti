import { SETTINGS_DOC_GROUPS, type SettingsDoc } from '@seti/shared'
import { Download, PenLine, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiGet, errorText } from '@/api'
import { CopyIconButton } from '@/components/CopyButton'
import { ToggleButton } from '@/components/ToggleButton'
import { HighlightedCode } from '@/components/highlight/HighlightedCode'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsBody, SettingsCard, SettingsHeader } from '../layout'
import { useMovedCard } from '../use-moved-card'
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
function exportDoc(doc: SettingsDoc): void {
  const url = URL.createObjectURL(new Blob([asJson(doc)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = exportName(new Date())
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

function Sections({ doc, defaults, filter }: { doc: SettingsDoc; defaults: SettingsDoc | null; filter: DocFilter }) {
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

/** Every setting as one JSON document, read only: search it, copy a part or export it whole. */
export function SettingsJsonPage() {
  const [doc, setDoc] = useState<SettingsDoc | null>(null)
  const [error, setError] = useState('')
  const [defaults, setDefaults] = useState<SettingsDoc | null>(null)
  const [filter, setFilter] = useState<DocFilter>({ query: '', group: null, modified: false })
  const load = useCallback(() => {
    apiGet<SettingsDoc>('/settings-doc').then(setDoc, (e: unknown) => {
      setError(errorText(e))
    })
    apiGet<SettingsDoc>('/settings-doc/defaults').then(setDefaults, () => {
      setDefaults(null)
    })
  }, [])
  useEffect(load, [load])
  useMovedCard(doc !== null)
  return (
    <SettingsBody
      header={
        <SettingsHeader
          title="JSON"
          description="Every setting as one document. Secrets show only as set; change a setting on its own page."
          actions={
            doc !== null && (
              <>
                <CopyIconButton text={asJson(doc)} label="Copy all settings" variant="outline" />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    exportDoc(doc)
                  }}
                >
                  <Download />
                  Export
                </Button>
              </>
            )
          }
        />
      }
    >
      <div className="space-y-4">
        <Filters filter={filter} onFilter={setFilter} />
        {doc === null ? (
          <p className={error === '' ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
            {error === '' ? 'Loading...' : error}
          </p>
        ) : (
          <Sections doc={doc} defaults={defaults} filter={filter} />
        )}
      </div>
    </SettingsBody>
  )
}
