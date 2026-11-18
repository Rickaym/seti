import type { McpConnector } from '@seti/shared'
import { Loader2, Plug, Plus, Search, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { apiPost } from '@/api'
import { ServiceIcon } from '@/components/service-icon/ServiceIcon'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useConnectors } from './useConnectors'
import { NEXT_SESSION_NOTE, usePluginAction } from './usePluginAction'

/** What adding it takes, in a word or two beside its name. */
function needOf(connector: McpConnector): string {
  if (connector.plugin !== null) {
    return 'plugin'
  }
  if (connector.oauth?.own_client === true) {
    return 'own OAuth app'
  }
  if (connector.fields.some((f) => f.required && f.secret)) {
    return connector.transport === 'stdio' ? 'local, key' : 'key'
  }
  return connector.transport === 'stdio' ? 'local' : 'sign-in'
}

const whereOf = (connector: McpConnector) => {
  if (connector.plugin !== null) {
    return connector.plugin
  }
  return connector.transport === 'stdio' ? [connector.command, ...connector.args].join(' ') : connector.url
}

function ConnectorRow({ connector, onOpen }: { connector: McpConnector; onOpen: () => void }) {
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-label={connector.title}
        onClick={onOpen}
        className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-accent pointer-coarse:min-h-11"
      >
        <ServiceIcon icon={connector.icon} fallback={Plug} className="mt-0.5" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{connector.title}</span>
            <span className="ml-auto shrink-0 border border-border px-1 text-2xs leading-4 text-muted-foreground">
              {needOf(connector)}
            </span>
          </span>
          <span className="truncate font-mono text-2xs text-muted-foreground">{whereOf(connector)}</span>
          {connector.description !== '' && (
            <span className="line-clamp-2 text-muted-foreground">{connector.description}</span>
          )}
        </span>
      </button>
    </li>
  )
}

function Group({
  label,
  connectors,
  onOpen,
}: {
  label: string
  connectors: McpConnector[]
  onOpen: (connector: McpConnector) => void
}) {
  if (connectors.length === 0) {
    return null
  }
  return (
    <section aria-label={label}>
      <h3 className="bg-muted/40 px-3 py-1 text-2xs font-medium text-muted-foreground uppercase">{label}</h3>
      <ul>
        {connectors.map((connector) => (
          <ConnectorRow
            key={connector.id}
            connector={connector}
            onOpen={() => {
              onOpen(connector)
            }}
          />
        ))}
      </ul>
    </section>
  )
}

/** Picks a server to add: a common connector, an MCP Registry entry, or a blank form. */
export function ConnectorCatalogDialog({
  onClose,
  onPick,
  onInstalled,
}: {
  onClose: () => void
  /** Opens the add form, from a connector or blank. */
  onPick: (connector: McpConnector | undefined) => void
  onInstalled: () => void
}) {
  const [query, setQuery] = useState('')
  const { common, registry, hasMore, error, loading, more } = useConnectors(query)
  const { busy, run } = usePluginAction(onInstalled)
  const searching = query.trim().length >= 2

  const open = (connector: McpConnector) => {
    const plugin = connector.plugin
    if (plugin === null) {
      onPick(connector)
      return
    }
    void run(async () => apiPost('/plugins/installed', { id: plugin }), `Installed ${plugin}`, NEXT_SESSION_NOTE)
  }

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
          <DialogTitle>Add MCP server</DialogTitle>
        </DialogHeader>
        <div className="relative border-b border-border px-4 py-2">
          <Search className="pointer-events-none absolute top-1/2 left-6 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search connectors"
            placeholder="Search connectors and the MCP Registry"
            value={query}
            className="pl-7"
            onChange={(e) => {
              setQuery(e.target.value)
            }}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto text-xs" aria-busy={loading || busy}>
          <Group label="Common" connectors={common} onOpen={open} />
          {searching && <Group label="MCP Registry" connectors={registry} onOpen={open} />}
          {error !== '' && (
            <p role="alert" className="flex items-center gap-1.5 px-3 py-2 text-muted-foreground">
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
              {error}
            </p>
          )}
          {!loading && common.length === 0 && registry.length === 0 && error === '' && (
            <p className="px-3 py-4 text-muted-foreground">
              {searching ? 'Nothing matches. Add it as a custom server.' : 'Type to search the MCP Registry.'}
            </p>
          )}
          {loading && (
            <p className="flex items-center gap-1.5 px-3 py-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Searching
            </p>
          )}
          {searching && hasMore && !loading && (
            <div className="px-3 py-2">
              <Button type="button" variant="outline" size="xs" onClick={() => void more()}>
                More results
              </Button>
            </div>
          )}
        </div>
        <DialogFooter className="border-t border-border px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              onPick(undefined)
            }}
          >
            <Plus />
            Custom server
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
