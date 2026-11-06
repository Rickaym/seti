import type { SandboxMcpAuth, SandboxMcpServer, SandboxMcpState } from '@seti/shared'
import { Ban, CircleCheck, TriangleAlert, type LucideIcon } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { cn } from '@/lib/utils'
import { SettingsCard } from './layout'

const STATE: Record<SandboxMcpState, { label: string; icon: LucideIcon; tone: string }> = {
  ok: { label: 'OK', icon: CircleCheck, tone: 'text-success' },
  needs_login: { label: 'Sign in again', icon: TriangleAlert, tone: 'text-warning-text' },
  refused: { label: 'Refused', icon: Ban, tone: 'text-muted-foreground' },
}

const AUTH: Record<SandboxMcpAuth, string> = {
  oauth: "Seti's proxy adds the host's sign-in to its requests.",
  connector: "Served by Anthropic's MCP proxy with the host's Claude login.",
  none: 'No sign-in; reached through the allowed hosts list.',
}

function StateBadge({ server }: { server: SandboxMcpServer }) {
  const state = STATE[server.state]
  const Icon = state.icon
  const label = server.state === 'needs_login' && server.auth === 'connector' ? 'Log in again' : state.label
  return (
    <Hint text={server.reason ?? AUTH[server.auth]}>
      <span
        role="img"
        aria-label={`${server.name}: ${label}`}
        className={cn('inline-flex shrink-0 items-center gap-1 font-medium', state.tone)}
      >
        <Icon className="size-3.5" aria-hidden />
        {label}
      </span>
    </Hint>
  )
}

/** The remote MCP servers sandboxed agents can use; their tokens stay on the host. */
export function SandboxMcpCard({ servers }: { servers: SandboxMcpServer[] }) {
  return (
    <SettingsCard title="MCP servers">
      <ul aria-label="MCP servers">
        {servers.map((server) => (
          <li
            key={`${server.auth}:${server.name}`}
            className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{server.name}</div>
              <div className="truncate font-mono text-2xs text-muted-foreground">{server.host}</div>
              {server.reason !== null && <div className="text-muted-foreground">{server.reason}</div>}
            </div>
            <StateBadge server={server} />
          </li>
        ))}
      </ul>
      <p className="border-t border-border p-3 text-2xs text-muted-foreground">
        Sandboxed agents reach servers you signed in to with claude on this machine; Seti adds the token on the way out
        and refreshes it when it expires.
      </p>
    </SettingsCard>
  )
}
