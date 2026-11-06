import type { SetiPlugin, SetiPluginView } from '@seti/shared'
import { FolderPlus, Loader2, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiPatch, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { DeleteIconButton } from '@/components/ui/table-action-buttons'
import { DefaultSwitch } from '@/panels/access/DefaultSwitch'
import { AddPluginDialog } from './AddPluginDialog'
import { InstalledActions } from './InstalledActions'
import { MarketplaceSection } from './MarketplaceSection'
import { PluginCatalogDialog } from './PluginCatalogDialog'
import { PluginList } from './PluginList'
import { EmptyRow, Section } from './Section'
import { matches } from './filter'
import { filterPlugins, pluginRows } from './plugin-rows'
import { useMarketplaces } from './useMarketplaces'
import { usePlugins } from './usePlugins'

function DefaultActions({ plugin, onChanged }: { plugin: SetiPluginView; onChanged: () => void }) {
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await action()
      toast.success(done)
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const message = `Stop loading ${plugin.name} into Seti agents? The folder ${plugin.path} is not touched.`
    if (!(await confirm({ title: 'Remove Seti default', message, confirmLabel: 'Remove', variant: 'destructive' }))) {
      return
    }
    await run(async () => apiDelete(`/plugins/defaults/${plugin.id}`), `Removed ${plugin.name}`)
  }

  return (
    <span className="flex items-center gap-2">
      <DefaultSwitch
        name={plugin.name}
        enabled={plugin.enabled}
        disabled={busy}
        onChange={(enabled) =>
          void run(
            async () => apiPatch<SetiPlugin>(`/plugins/defaults/${plugin.id}`, { enabled }),
            `${plugin.name} is ${enabled ? 'on' : 'off'} by default`,
          )
        }
      />
      <DeleteIconButton aria-label={`Remove ${plugin.name}`} loading={busy} onClick={() => void remove()} />
    </span>
  )
}

export function PluginSection({
  query,
  refreshToken,
  onChanged,
  onLoading,
}: {
  query: string
  refreshToken: number
  onChanged: () => void
  /** Hears whether plugins or marketplaces are loading, for the page's Refresh button. */
  onLoading: (loading: boolean) => void
}) {
  const { listing, loading, error, reload } = usePlugins(refreshToken)
  const markets = useMarketplaces(refreshToken)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [adding, setAdding] = useState<'local' | 'catalog' | null>(null)
  const installedError = listing?.installed_error ?? null
  const rows = useMemo(() => (listing === null ? [] : filterPlugins(pluginRows(listing), query)), [listing, query])
  const autoOpen = useMemo(
    () => new Set(rows.filter((row) => !matches(query, row.name, row.origin)).map((row) => row.key)),
    [rows, query],
  )

  useEffect(() => {
    onLoading(loading || markets.loading)
  }, [loading, markets.loading, onLoading])

  const toggle = (key: string) => {
    const next = new Set(expanded)
    if (!next.delete(key)) {
      next.add(key)
    }
    setExpanded(next)
  }

  const changed = () => {
    reload()
    markets.reload()
    onChanged()
  }

  return (
    <>
      <Section
        title="Plugins"
        count={rows.length}
        actions={
          <>
            {loading && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading plugins" />
            )}
            <Hint text="Install a plugin from a marketplace into Claude Code">
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-label="Add plugin"
                onClick={() => {
                  setAdding('catalog')
                }}
              >
                <Plus />
                Add
              </Button>
            </Hint>
            <Hint text="Load a plugin folder into every Seti agent">
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-label="Add local plugin"
                onClick={() => {
                  setAdding('local')
                }}
              >
                <FolderPlus />
                Local
              </Button>
            </Hint>
          </>
        }
      >
        <p className="border-b border-border px-3 py-1.5 text-muted-foreground">
          Seti defaults load into every Seti agent without changing Claude Code. Installed plugins live in Claude
          Code&apos;s settings, so your terminal sees the same ones; agents load them when a session starts.
        </p>
        {error !== '' && <p className="border-b border-border px-3 py-2 text-destructive">{error}</p>}
        {installedError !== null && (
          <p className="border-b border-border px-3 py-2 text-muted-foreground">
            Could not list Claude Code plugins: {installedError}
          </p>
        )}
        {listing === null && loading && <EmptyRow>Reading plugins...</EmptyRow>}
        {listing !== null && rows.length === 0 && (
          <EmptyRow>{query === '' ? 'No plugins.' : 'No matching plugins.'}</EmptyRow>
        )}
        <PluginList
          rows={rows}
          expanded={expanded}
          autoOpen={autoOpen}
          onToggle={toggle}
          actions={(row) => (
            <>
              {row.seti !== null && <DefaultActions plugin={row.seti} onChanged={changed} />}
              {row.claude !== null && <InstalledActions plugin={row.claude} onChanged={changed} />}
            </>
          )}
        />
      </Section>
      <MarketplaceSection
        marketplaces={markets.marketplaces}
        loading={markets.loading}
        error={markets.error}
        onChanged={changed}
      />
      {adding === 'local' && (
        <AddPluginDialog
          onClose={() => {
            setAdding(null)
          }}
          onAdded={(plugin) => {
            setAdding(null)
            toast.success(`Added ${plugin.name} as a Seti default`)
            changed()
          }}
        />
      )}
      {adding === 'catalog' && (
        <PluginCatalogDialog
          marketplaces={markets.marketplaces ?? []}
          onClose={() => {
            setAdding(null)
          }}
          onInstalled={() => {
            setAdding(null)
            changed()
          }}
        />
      )}
    </>
  )
}
