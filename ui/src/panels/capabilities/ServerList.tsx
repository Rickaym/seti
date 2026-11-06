import type { McpServer, McpStatus, McpTool } from '@seti/shared'
import { ChevronDown, ChevronRight, KeyRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { explainMcpError } from '@/lib/mcp-error'
import { cn } from '@/lib/utils'
import type { ServerView } from './filter'

const STATUS_STYLE: Record<McpStatus, { label: string; className: string }> = {
  connected: { label: 'connected', className: 'bg-success/20 text-foreground' },
  'needs-auth': { label: 'needs auth', className: 'bg-warning/30 text-foreground' },
  failed: { label: 'failed', className: 'bg-destructive/20 text-destructive' },
  pending: { label: 'pending', className: 'bg-muted text-muted-foreground' },
  disabled: { label: 'disabled', className: 'bg-muted text-muted-foreground' },
}

function McpStatusPill({ status }: { status: McpStatus }) {
  const style = STATUS_STYLE[status]
  return (
    <span className={cn('px-1.5 py-0.5 text-2xs font-semibold whitespace-nowrap uppercase', style.className)}>
      {style.label}
    </span>
  )
}

function Flag({ label, className }: { label: string; className: string }) {
  return <span className={cn('border px-1 text-2xs leading-4 whitespace-nowrap', className)}>{label}</span>
}

function ToolFlags({ tool }: { tool: McpTool }) {
  return (
    <span className="flex shrink-0 gap-1">
      {tool.read_only && <Flag label="read-only" className="border-success/50 text-success" />}
      {tool.destructive && <Flag label="destructive" className="border-destructive/50 text-destructive" />}
      {tool.open_world && <Flag label="open-world" className="border-primary/40 text-primary" />}
    </span>
  )
}

function ToolList({ tools }: { tools: McpTool[] }) {
  if (tools.every((tool) => tool.description === '')) {
    return (
      <ul className="grid grid-cols-3 gap-x-6 border-t border-border bg-muted/30 py-1.5 pr-3 pl-9 max-md:grid-cols-1 max-md:pl-4">
        {tools.map((tool) => (
          <li key={tool.name} className="flex min-w-0 items-center justify-between gap-2 py-1">
            <span className="truncate font-medium" title={tool.name}>
              {tool.name}
            </span>
            <ToolFlags tool={tool} />
          </li>
        ))}
      </ul>
    )
  }
  return (
    <ul className="border-t border-border bg-muted/30 py-1">
      {tools.map((tool) => (
        <li
          key={tool.name}
          className="grid grid-cols-[minmax(0,19rem)_15rem_minmax(0,1fr)] items-start gap-x-3 px-3 py-1.5 pl-9 max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-y-0.5 max-md:pl-4"
        >
          <span className="truncate font-medium" title={tool.name}>
            {tool.name}
          </span>
          <ToolFlags tool={tool} />
          <p className="line-clamp-2 text-muted-foreground max-md:col-span-2" title={tool.description}>
            {tool.description}
          </p>
        </li>
      ))}
    </ul>
  )
}

const origin = (server: McpServer) =>
  server.source === null || server.source === server.scope
    ? (server.scope ?? '-')
    : `${server.source} / ${server.scope ?? '-'}`

function SignInNote({ server, onAuthenticate }: { server: McpServer; onAuthenticate: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-9 max-md:pl-4">
      <span className="bg-warning/20 px-1.5 py-0.5">Not signed in.</span>
      <Hint text={`Sign in to ${server.name} through its OAuth page`}>
        <Button type="button" size="xs" onClick={onAuthenticate}>
          <KeyRound />
          Sign in
        </Button>
      </Hint>
    </div>
  )
}

function ErrorNote({ error }: { error: string }) {
  return (
    <div className="space-y-1 px-3 pb-2 pl-9">
      <p className="text-destructive">{explainMcpError(error)}</p>
      <details>
        <summary className="flex min-h-6 w-fit cursor-pointer items-center text-muted-foreground hover:text-foreground pointer-coarse:min-h-11">
          Raw error
        </summary>
        <pre className="mt-1 max-h-40 overflow-auto bg-muted p-2 font-mono text-2xs break-all whitespace-pre-wrap text-muted-foreground">
          {error}
        </pre>
      </details>
    </div>
  )
}

function StatusNote({ server, onAuthenticate }: { server: McpServer; onAuthenticate: () => void }) {
  const error = server.status !== 'needs-auth' && server.error !== null ? <ErrorNote error={server.error} /> : null
  if (server.sign_in === 'required') {
    return (
      <>
        <SignInNote server={server} onAuthenticate={onAuthenticate} />
        {error}
      </>
    )
  }
  if (server.status === 'needs-auth') {
    return (
      <p className="px-3 pb-2 pl-9">
        <span className="bg-warning/20 px-1.5 py-0.5">
          Not signed in. Run /mcp in an interactive Claude Code session to sign in, then refresh.
        </span>
      </p>
    )
  }
  return error
}

interface RowProps {
  view: ServerView
  open: boolean
  onToggle: () => void
  onAuthenticate: () => void
  actions: ReactNode
}

function ServerRow({ view, open, onToggle, onAuthenticate, actions }: RowProps) {
  const { server, tools } = view
  const Chevron = open ? ChevronDown : ChevronRight
  const expandable = server.tools.length > 0
  return (
    <li className="border-b border-border last:border-b-0">
      <div className="flex items-center pr-3 max-md:flex-wrap max-md:pb-2">
        <button
          type="button"
          disabled={!expandable}
          aria-expanded={expandable ? open : undefined}
          onClick={onToggle}
          className="grid min-w-0 flex-1 grid-cols-[1rem_minmax(0,16rem)_6.5rem_minmax(0,1fr)_9rem_7rem] items-center gap-x-3 px-3 py-2 text-left enabled:hover:bg-accent max-md:basis-full max-md:grid-cols-[1rem_minmax(0,1fr)_auto] max-md:gap-y-1"
        >
          <Chevron className={cn('size-4 text-muted-foreground', !expandable && 'invisible')} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{server.name}</span>
            {server.server_version !== null && (
              <span className="block truncate text-2xs text-muted-foreground">{server.server_version}</span>
            )}
          </span>
          <span>
            <McpStatusPill status={server.status} />
          </span>
          <span
            className="truncate text-muted-foreground max-md:col-span-2 max-md:col-start-2"
            title={server.transport?.target ?? undefined}
          >
            {server.transport === null ? (
              '-'
            ) : (
              <>
                <span className="mr-2 text-2xs font-semibold uppercase">{server.transport.type}</span>
                {server.transport.target}
              </>
            )}
          </span>
          <span className="truncate text-muted-foreground max-md:col-start-2">{origin(server)}</span>
          <span className="text-right tabular-nums">
            {view.toolHit ? `${String(tools.length)} of ${String(server.tools.length)}` : server.tools.length} tools
          </span>
        </button>
        <div className="flex shrink-0 items-center max-md:ml-auto">{actions}</div>
      </div>
      <StatusNote server={server} onAuthenticate={onAuthenticate} />
      {open && <ToolList tools={tools} />}
    </li>
  )
}

export function ServerList({
  views,
  expanded,
  onToggle,
  onAuthenticate,
  actions,
}: {
  views: ServerView[]
  expanded: ReadonlySet<string>
  onToggle: (name: string) => void
  onAuthenticate: (server: McpServer) => void
  actions: (server: McpServer) => ReactNode
}) {
  return (
    <ul>
      {views.map((view) => (
        <ServerRow
          key={view.server.name}
          view={view}
          open={expanded.has(view.server.name) !== view.toolHit}
          onToggle={() => {
            onToggle(view.server.name)
          }}
          onAuthenticate={() => {
            onAuthenticate(view.server)
          }}
          actions={actions(view.server)}
        />
      ))}
    </ul>
  )
}
