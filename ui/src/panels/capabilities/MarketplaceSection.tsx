import type { Marketplace } from '@seti/shared'
import { Loader2, Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { apiDelete, apiPost } from '@/api'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Input } from '@/components/ui/input'
import { DeleteIconButton } from '@/components/ui/table-action-buttons'
import { EmptyRow, Section } from './Section'
import { usePluginAction } from './usePluginAction'

function AddMarketplaceDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [source, setSource] = useState('')
  const { busy, run } = usePluginAction(onAdded)

  return (
    <CrudEditDialog
      open
      title="Add marketplace"
      onCancel={onClose}
      onSave={() =>
        void run(async () => apiPost('/plugins/marketplaces', { source: source.trim() }), `Added ${source.trim()}`)
      }
      saving={busy}
      canSave={source.trim() !== ''}
      saveLabel="Add"
      savingLabel="Adding..."
      saveIcon={Plus}
    >
      <Field label="Source" full>
        <Input
          aria-label="Marketplace source"
          value={source}
          onChange={(e) => {
            setSource(e.target.value)
          }}
          placeholder="owner/repo"
        />
      </Field>
      <p className="col-span-full text-xs text-muted-foreground">
        A GitHub owner/repo, a git URL or a local path holding .claude-plugin/marketplace.json. Claude Code adds it to
        your user settings, so your terminal sees it too.
      </p>
    </CrudEditDialog>
  )
}

function MarketplaceActions({ marketplace, onChanged }: { marketplace: Marketplace; onChanged: () => void }) {
  const confirm = useConfirm()
  const { busy, run } = usePluginAction(onChanged)
  const path = `/plugins/marketplaces/${encodeURIComponent(marketplace.name)}`

  const remove = async () => {
    const message = `Remove the ${marketplace.name} marketplace (${marketplace.source}) from Claude Code? Its plugins can no longer be installed or updated from it.`
    if (!(await confirm({ title: 'Remove marketplace', message, confirmLabel: 'Remove', variant: 'destructive' }))) {
      return
    }
    await run(async () => apiDelete(path), `Removed ${marketplace.name}`)
  }

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        aria-label={`Update ${marketplace.name}`}
        title={`Update ${marketplace.name}`}
        disabled={busy}
        onClick={() => void run(async () => apiPost(`${path}/update`), `Updated ${marketplace.name}`)}
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
      </Button>
      {!marketplace.built_in && (
        <DeleteIconButton aria-label={`Remove ${marketplace.name}`} disabled={busy} onClick={() => void remove()} />
      )}
    </span>
  )
}

/** Plugin marketplaces Claude Code knows, with their plugin counts. */
export function MarketplaceSection({
  marketplaces,
  loading,
  error,
  onChanged,
}: {
  marketplaces: Marketplace[] | null
  loading: boolean
  error: string
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)
  return (
    <>
      <Section
        title="Marketplaces"
        count={marketplaces?.length ?? 0}
        actions={
          <>
            {loading && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading marketplaces" />
            )}
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label="Add marketplace"
              onClick={() => {
                setAdding(true)
              }}
            >
              <Plus />
              Add
            </Button>
          </>
        }
      >
        {error !== '' && <p className="border-b border-border px-3 py-2 text-destructive">{error}</p>}
        {marketplaces !== null && marketplaces.length === 0 && <EmptyRow>No marketplaces.</EmptyRow>}
        <ul aria-label="Marketplaces">
          {marketplaces?.map((marketplace) => (
            <li
              key={marketplace.name}
              aria-label={`${marketplace.name} marketplace`}
              className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 max-md:flex-wrap"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{marketplace.name}</span>
                <span className="block truncate text-muted-foreground" title={marketplace.source}>
                  {marketplace.source}
                </span>
              </span>
              <span className="shrink-0 text-muted-foreground">
                {marketplace.plugin_count} plugin{marketplace.plugin_count === 1 ? '' : 's'}
              </span>
              <MarketplaceActions marketplace={marketplace} onChanged={onChanged} />
            </li>
          ))}
        </ul>
      </Section>
      {adding && (
        <AddMarketplaceDialog
          onClose={() => {
            setAdding(false)
          }}
          onAdded={() => {
            setAdding(false)
            onChanged()
          }}
        />
      )}
    </>
  )
}
