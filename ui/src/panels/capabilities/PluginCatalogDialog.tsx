import {
  componentLabel,
  PLUGIN_COMPONENT_KINDS,
  type CatalogPlugin,
  type Marketplace,
  type PluginCatalog,
  type PluginPreview,
} from '@seti/shared'
import { ArrowLeft, Download, Loader2, Search, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiGet, apiPost, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { NEXT_SESSION_NOTE, usePluginAction } from './usePluginAction'

const SEARCH_DELAY_MS = 250
const ALL = ''

function InstalledTag() {
  return (
    <span className="border border-primary/40 px-1 text-2xs leading-4 whitespace-nowrap text-primary">installed</span>
  )
}

function useCatalog(query: string, marketplace: string) {
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let stale = false
    const timer = setTimeout(() => {
      setLoading(true)
      const params = new URLSearchParams()
      if (query.trim() !== '') {
        params.set('q', query.trim())
      }
      if (marketplace !== ALL) {
        params.set('marketplace', marketplace)
      }
      apiGet<PluginCatalog>(`/plugins/catalog?${params.toString()}`)
        .then((next) => {
          if (!stale) {
            setCatalog(next)
            setError('')
          }
        })
        .catch((e: unknown) => {
          if (!stale) {
            setError(errorText(e))
          }
        })
        .finally(() => {
          if (!stale) {
            setLoading(false)
          }
        })
    }, SEARCH_DELAY_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query, marketplace])

  return { catalog, error, loading }
}

function CatalogRow({ plugin, onOpen }: { plugin: CatalogPlugin; onOpen: () => void }) {
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-label={`${plugin.name} from ${plugin.marketplace}`}
        onClick={onOpen}
        className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-accent pointer-coarse:min-h-11"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{plugin.name}</span>
          {plugin.installed && <InstalledTag />}
          <span className="ml-auto shrink-0 text-2xs text-muted-foreground">{plugin.version ?? ''}</span>
        </span>
        <span className="truncate text-2xs text-muted-foreground">{plugin.marketplace}</span>
        {plugin.description !== '' && <span className="line-clamp-2 text-muted-foreground">{plugin.description}</span>}
      </button>
    </li>
  )
}

function Components({ preview }: { preview: PluginPreview }) {
  const { components } = preview
  if (components === null) {
    return (
      <p className="text-muted-foreground">
        Its marketplace does not list what it brings; Claude Code fetches it from{' '}
        {preview.source === '' ? 'its source' : preview.source} on install.
      </p>
    )
  }
  const kinds = PLUGIN_COMPONENT_KINDS.filter((kind) => components[kind].length > 0)
  if (kinds.length === 0) {
    return <p className="text-muted-foreground">Its marketplace lists no skills, commands, agents, hooks or servers.</p>
  }
  return (
    <dl className="space-y-1">
      {kinds.map((kind) => (
        <div key={kind} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3">
          <dt className="font-semibold">{componentLabel(kind, components[kind].length)}</dt>
          <dd className="break-words">{components[kind].join(', ')}</dd>
        </div>
      ))}
    </dl>
  )
}

function PluginDetail({
  plugin,
  onBack,
  onInstalled,
}: {
  plugin: CatalogPlugin
  onBack: () => void
  onInstalled: () => void
}) {
  const [preview, setPreview] = useState<PluginPreview | null>(null)
  const [error, setError] = useState('')
  const { busy, run } = usePluginAction(onInstalled)

  useEffect(() => {
    let stale = false
    apiGet<PluginPreview>(`/plugins/catalog/preview?id=${encodeURIComponent(plugin.id)}`)
      .then((next) => {
        if (!stale) {
          setPreview(next)
        }
      })
      .catch((e: unknown) => {
        if (!stale) {
          setError(errorText(e))
        }
      })
    return () => {
      stale = true
    }
  }, [plugin.id])

  const install = () =>
    void run(
      async () => apiPost('/plugins/installed', { id: plugin.id }),
      `Installed ${plugin.name}`,
      `New agents get it now. ${NEXT_SESSION_NOTE}`,
    )
  let installLabel = busy ? 'Installing...' : 'Install'
  if (plugin.installed) {
    installLabel = 'Installed'
  }

  return (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-sm font-semibold">
            {plugin.name}
            {plugin.installed && <InstalledTag />}
          </p>
          <p className="break-all text-muted-foreground">
            {plugin.id}
            {plugin.version !== null && ` | ${plugin.version}`}
          </p>
        </div>
        {plugin.description !== '' && <p>{plugin.description}</p>}
        {error !== '' && <p className="text-destructive">{error}</p>}
        {preview === null && error === '' && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Reading what it brings...
          </p>
        )}
        {preview !== null && (
          <>
            <Components preview={preview} />
            {preview.source !== '' && <p className="break-all text-muted-foreground">Source: {preview.source}</p>}
            {preview.homepage !== null && (
              <a
                href={preview.homepage}
                target="_blank"
                rel="noreferrer"
                className="block break-all text-primary underline-offset-2 hover:underline"
              >
                {preview.homepage}
              </a>
            )}
          </>
        )}
        <p className="flex items-start gap-2 border border-warning/40 bg-warning/10 px-2 py-1.5">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Plugins run third-party code on this machine as you; install only ones you trust.
        </p>
      </div>
      <DialogFooter className="border-t border-border px-4 py-3 sm:justify-end">
        <Button type="button" variant="outline" onClick={onBack}>
          <ArrowLeft />
          Back
        </Button>
        <Button type="button" onClick={install} disabled={busy || plugin.installed}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />}
          {installLabel}
        </Button>
      </DialogFooter>
    </>
  )
}

/** Searches the configured marketplaces and installs a plugin into Claude Code at user scope. */
export function PluginCatalogDialog({
  marketplaces,
  onClose,
  onInstalled,
}: {
  marketplaces: Marketplace[]
  onClose: () => void
  onInstalled: () => void
}) {
  const [query, setQuery] = useState('')
  const [marketplace, setMarketplace] = useState(ALL)
  const [open, setOpen] = useState<CatalogPlugin | null>(null)
  const { catalog, error, loading } = useCatalog(query, marketplace)
  const shown = catalog?.plugins.length ?? 0

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent className="flex max-h-[92vh] min-h-0 flex-col gap-0 overflow-hidden border p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle>Add plugin</DialogTitle>
        </DialogHeader>
        {open === null ? (
          <>
            <div className="flex items-center gap-2 border-b border-border px-4 py-3 max-md:flex-wrap">
              <div className="relative min-w-0 flex-1 max-md:basis-full">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Search marketplace plugins"
                  placeholder="Search by name or description"
                  className="pl-7"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                  }}
                />
              </div>
              <NativeSelect
                aria-label="Marketplace"
                className="max-md:w-full"
                value={marketplace}
                onChange={(e) => {
                  setMarketplace(e.target.value)
                }}
              >
                <NativeSelectOption value={ALL}>All marketplaces</NativeSelectOption>
                {marketplaces.map((entry) => (
                  <NativeSelectOption key={entry.name} value={entry.name}>
                    {entry.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto text-xs">
              {error !== '' && <p className="px-4 py-3 text-destructive">{error}</p>}
              {catalog === null && loading && error === '' && (
                <p className="flex items-center gap-2 px-4 py-3 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Reading marketplaces...
                </p>
              )}
              {catalog !== null && shown === 0 && <p className="px-4 py-3 text-muted-foreground">No plugins match.</p>}
              <ul aria-label="Marketplace plugins" aria-busy={loading}>
                {catalog?.plugins.map((plugin) => (
                  <CatalogRow
                    key={plugin.id}
                    plugin={plugin}
                    onOpen={() => {
                      setOpen(plugin)
                    }}
                  />
                ))}
              </ul>
              {catalog !== null && catalog.total > shown && (
                <p className="px-4 py-2 text-muted-foreground">
                  Showing {shown} of {catalog.total}; search to narrow the list.
                </p>
              )}
            </div>
          </>
        ) : (
          <PluginDetail
            key={open.id}
            plugin={open}
            onBack={() => {
              setOpen(null)
            }}
            onInstalled={onInstalled}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
