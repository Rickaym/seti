import { componentLabel, PLUGIN_COMPONENT_KINDS, type PluginComponentKind, type PluginComponents } from '@seti/shared'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { PluginRow } from './plugin-rows'

function summary(components: PluginComponents | null): string {
  if (components === null) {
    return 'components unknown'
  }
  const parts = PLUGIN_COMPONENT_KINDS.filter((kind) => components[kind].length > 0).map((kind) =>
    componentLabel(kind, components[kind].length),
  )
  return parts.length === 0 ? 'no components' : parts.join(', ')
}

const KIND_TITLE: Record<PluginComponentKind, string> = {
  skills: 'Skills',
  agents: 'Agents',
  commands: 'Commands',
  hooks: 'Hooks',
  mcp_servers: 'MCP servers',
  lsp_servers: 'LSP servers',
}

function ComponentLists({ row }: { row: PluginRow }) {
  const kinds = PLUGIN_COMPONENT_KINDS.filter((kind) => (row.components?.[kind].length ?? 0) > 0)
  return (
    <div className="space-y-1.5 border-t border-border bg-muted/30 px-3 py-2 pl-9">
      <p className="break-all text-muted-foreground">{row.detail}</p>
      {kinds.map((kind) => (
        <div key={kind} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3">
          <span className="font-semibold">{KIND_TITLE[kind]}</span>
          <span className="break-words">{row.components?.[kind].join(', ')}</span>
        </div>
      ))}
    </div>
  )
}

function StatePill({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        'px-1.5 py-0.5 text-2xs font-semibold whitespace-nowrap uppercase',
        enabled ? 'bg-success/20 text-foreground' : 'bg-muted text-muted-foreground',
      )}
    >
      {enabled ? 'enabled' : 'disabled'}
    </span>
  )
}

const ORIGIN_CELL = 'max-md:col-span-2 max-md:col-start-2'

function OriginTag({ row }: { row: PluginRow }) {
  if (row.seti !== null) {
    return (
      <span
        className={cn(
          'justify-self-start border border-primary/40 px-1 text-2xs leading-4 whitespace-nowrap text-primary',
          ORIGIN_CELL,
        )}
      >
        Seti default
      </span>
    )
  }
  return (
    <span className={cn('truncate text-muted-foreground', ORIGIN_CELL)} title={row.origin}>
      {row.origin}
    </span>
  )
}

function PluginRowView({
  row,
  open,
  onToggle,
  actions,
}: {
  row: PluginRow
  open: boolean
  onToggle: () => void
  actions: ReactNode
}) {
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <li className="border-b border-border last:border-b-0">
      <div className="flex items-center pr-3 max-md:flex-wrap max-md:pb-2">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${row.name} plugin`}
          onClick={onToggle}
          className="grid min-w-0 flex-1 grid-cols-[1rem_minmax(0,16rem)_minmax(0,13rem)_6rem_minmax(0,1fr)_4rem] items-center gap-x-3 px-3 py-2 text-left hover:bg-accent max-md:basis-full max-md:grid-cols-[1rem_minmax(0,1fr)_auto] max-md:gap-y-1"
        >
          <Chevron className="size-4 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{row.name}</span>
            {row.version !== null && (
              <span className="block truncate text-2xs text-muted-foreground">{row.version}</span>
            )}
          </span>
          <OriginTag row={row} />
          <span className="max-md:col-start-3 max-md:row-start-1">
            <StatePill enabled={row.enabled} />
          </span>
          <span className="truncate text-muted-foreground max-md:col-start-2">{summary(row.components)}</span>
          <span className="truncate text-right text-muted-foreground">{row.scope ?? '-'}</span>
        </button>
        <span className="flex w-28 shrink-0 justify-end max-md:ml-auto">{actions}</span>
      </div>
      {row.problem !== null && <p className="px-3 pb-2 pl-9 break-words text-destructive">{row.problem}</p>}
      {open && <ComponentLists row={row} />}
    </li>
  )
}

export function PluginList({
  rows,
  expanded,
  autoOpen,
  onToggle,
  actions,
}: {
  rows: PluginRow[]
  expanded: ReadonlySet<string>
  /** Rows opened by a search that matched their components rather than their name. */
  autoOpen: ReadonlySet<string>
  onToggle: (key: string) => void
  actions: (row: PluginRow) => ReactNode
}) {
  return (
    <ul>
      {rows.map((row) => (
        <PluginRowView
          key={row.key}
          row={row}
          open={autoOpen.has(row.key) !== expanded.has(row.key)}
          onToggle={() => {
            onToggle(row.key)
          }}
          actions={actions(row)}
        />
      ))}
    </ul>
  )
}
