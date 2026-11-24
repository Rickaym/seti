import { SETTINGS_DOC_GROUPS, type SettingsDoc } from '@seti/shared'
import { Download, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiGet, errorText } from '@/api'
import { CopyIconButton } from '@/components/CopyButton'
import { HighlightedCode } from '@/components/highlight/HighlightedCode'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsBody, SettingsCard, SettingsHeader } from '../layout'
import { asJson, docSections, exportName, shownSections } from './settings-json'

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

function Filters({
  query,
  group,
  onQuery,
  onGroup,
}: {
  query: string
  group: string | null
  onQuery: (text: string) => void
  onGroup: (group: string | null) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-0 flex-1 basis-56">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search settings"
          placeholder="Search keys and values"
          className="h-7 pl-8"
          value={query}
          onChange={(e) => {
            onQuery(e.target.value)
          }}
        />
      </div>
      <Select
        value={group ?? ALL}
        onValueChange={(value) => {
          onGroup(value === ALL ? null : value)
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
    </div>
  )
}

function Sections({ doc, query, group }: { doc: SettingsDoc; query: string; group: string | null }) {
  const sections = useMemo(() => docSections(doc), [doc])
  const shown = shownSections(sections, query, group)
  if (shown.length === 0) {
    return <p className="text-sm text-muted-foreground">No setting matches.</p>
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
            actions={<CopyIconButton text={text} label={`Copy ${section.path}`} />}
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
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<string | null>(null)
  const load = useCallback(() => {
    apiGet<SettingsDoc>('/settings-doc').then(setDoc, (e: unknown) => {
      setError(errorText(e))
    })
  }, [])
  useEffect(load, [load])
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
        <Filters query={query} group={group} onQuery={setQuery} onGroup={setGroup} />
        {doc === null ? (
          <p className={error === '' ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
            {error === '' ? 'Loading...' : error}
          </p>
        ) : (
          <Sections doc={doc} query={query} group={group} />
        )}
      </div>
    </SettingsBody>
  )
}
