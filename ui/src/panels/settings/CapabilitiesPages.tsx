import type { CapabilitiesSnapshot, Repo } from '@seti/shared'
import { Loader2, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { apiGet } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { CommandList, ModelList, SkillGroups, SubagentList } from '@/panels/capabilities/CommandSections'
import { McpSection } from '@/panels/capabilities/McpSection'
import { PluginSection } from '@/panels/capabilities/PluginSection'
import { Section } from '@/panels/capabilities/Section'
import { filterCommands, filterGroups, filterServers, matches, normalize } from '@/panels/capabilities/filter'
import { useCapabilities, USER_SCOPE } from '@/panels/capabilities/useCapabilities'
import { SettingsBody, SettingsHeader } from './layout'
import type { ProbedPageKey } from './pages'

const TICK_MS = 15_000

type ProbedKind = 'mcp' | 'skills' | 'subagents'

const VIEWS: Record<ProbedKind, { label: string; description: string; search: string }> = {
  mcp: {
    label: 'MCP servers',
    description: 'The MCP servers Claude Code connects to, with their tools and sign-in.',
    search: 'Search servers and tools',
  },
  skills: {
    label: 'Skills',
    description: 'Skills and slash commands agents get from plugins and from Claude Code.',
    search: 'Search skills and commands',
  },
  subagents: {
    label: 'Subagents',
    description: 'Subagents agents can hand work to, and the models they can pick.',
    search: 'Search subagents and models',
  },
}

function ProbedAgo({ at }: { at: string }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, TICK_MS)
    return () => {
      clearInterval(timer)
    }
  }, [])
  return <span className="text-xs text-muted-foreground">Probed {relativeTime(at, now)}</span>
}

function ScopeSelect({ value, onChange }: { value: string; onChange: (scope: string) => void }) {
  const [repos, setRepos] = useState<Repo[]>([])
  useEffect(() => {
    apiGet<Repo[]>('/repos')
      .then(setRepos)
      .catch(() => {
        setRepos([])
      })
  }, [])
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label="Config scope" size="sm" className="w-56 max-md:w-auto max-md:max-w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={USER_SCOPE}>User</SelectItem>
        {repos.map((repo) => (
          <SelectItem key={repo.id} value={repo.id}>
            {repo.slug}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

interface BodyProps {
  view: ProbedKind
  snapshot: CapabilitiesSnapshot
  query: string
  repoId: string | undefined
  onReload: () => void
  onRefresh: () => void
}

function ProbedBody({ view, snapshot, query, repoId, onReload, onRefresh }: BodyProps) {
  const q = normalize(query)
  const searching = q !== ''
  const views = useMemo(() => filterServers(snapshot.servers, q), [snapshot, q])
  const groups = useMemo(() => filterGroups(snapshot.skill_groups, q), [snapshot, q])
  const builtins = useMemo(() => filterCommands(snapshot.builtin_commands, q), [snapshot, q])
  const agents = snapshot.subagents.filter((agent) => matches(q, agent.name, agent.description))
  const models = snapshot.models.filter((model) => matches(q, model.display_name, model.value, model.description))

  switch (view) {
    case 'mcp':
      return (
        <McpSection views={views} searching={searching} repoId={repoId} onReload={onReload} onRefresh={onRefresh} />
      )
    case 'skills':
      return (
        <div className="space-y-4">
          <Section
            title="Skills and commands"
            count={groups.reduce((total, group) => total + group.commands.length, 0)}
          >
            <SkillGroups groups={groups} forceOpen={searching} />
          </Section>
          <Section title="Built-in commands" count={builtins.length} defaultOpen={false} forceOpen={searching}>
            <CommandList commands={builtins} />
          </Section>
        </div>
      )
    case 'subagents':
      return (
        <div className="grid grid-cols-2 items-start gap-4 max-md:grid-cols-1">
          <Section title="Subagents" count={agents.length}>
            <SubagentList agents={agents} />
          </Section>
          <Section title="Models" count={models.length}>
            <ModelList models={models} />
          </Section>
        </div>
      )
  }
}

function Probing() {
  return (
    <div className="flex items-center gap-2 border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      Starting Claude Code and waiting for MCP servers to connect. This takes up to 20 s.
    </div>
  )
}

interface SearchProps {
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
}

function SearchBox({ label, placeholder, value, onChange }: SearchProps) {
  return (
    <div className="relative w-96 max-md:w-full">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label={label}
        placeholder={placeholder}
        className="pl-8"
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
    </div>
  )
}

type Capabilities = ReturnType<typeof useCapabilities>

function RefreshButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={busy}>
      <RefreshCw className={cn(busy && 'animate-spin')} />
      Refresh
    </Button>
  )
}

/** When the probe ran, its scope, and Refresh, for the header above a probed view. */
function ProbedActions({ capabilities, onRefresh }: { capabilities: Capabilities; onRefresh: () => void }) {
  const { scope, snapshot, loading, selectScope } = capabilities
  return (
    <>
      {snapshot !== null && <ProbedAgo key={snapshot.probed_at} at={snapshot.probed_at} />}
      <ScopeSelect value={scope} onChange={selectScope} />
      <RefreshButton busy={loading} onClick={onRefresh} />
    </>
  )
}

/** A searchable view of the probe: MCP servers, skills or subagents. */
function ProbedView({ view, capabilities }: { view: ProbedKind; capabilities: Capabilities }) {
  const { scope, snapshot, loading, error, refresh, reload } = capabilities
  const [query, setQuery] = useState('')
  const { label, search } = VIEWS[view]
  return (
    <>
      {error !== '' && (
        <div className="mb-4 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {snapshot === null && loading && <Probing />}
      {snapshot !== null && (
        <div className="space-y-4 text-xs">
          <div className="flex items-center gap-3 max-md:flex-wrap">
            <SearchBox label={`Search ${label.toLowerCase()}`} placeholder={search} value={query} onChange={setQuery} />
            <span className="truncate text-xs text-muted-foreground">
              {snapshot.cwd}
              {snapshot.pending_timed_out && ' | some servers were still connecting when the probe stopped'}
            </span>
          </div>
          <ProbedBody
            view={view}
            snapshot={snapshot}
            query={query}
            repoId={scope === USER_SCOPE ? undefined : scope}
            onReload={reload}
            onRefresh={refresh}
          />
        </div>
      )}
    </>
  )
}

function PluginList({
  refreshes,
  onChanged,
  onLoading,
}: {
  refreshes: number
  onChanged: () => void
  onLoading: (loading: boolean) => void
}) {
  const [query, setQuery] = useState('')
  return (
    <div className="space-y-4 text-xs">
      <SearchBox label="Search plugins" placeholder="Search plugins" value={query} onChange={setQuery} />
      <PluginSection query={normalize(query)} refreshToken={refreshes} onChanged={onChanged} onLoading={onLoading} />
    </div>
  )
}

interface PageProps {
  capabilities: Capabilities
  refreshes: number
  onRefresh: () => void
}

/** Seti's plugin folders and the Claude Code plugins agents load. */
function PluginsPage({ capabilities, refreshes, onRefresh }: PageProps) {
  const [pluginsLoading, setPluginsLoading] = useState(false)
  return (
    <SettingsBody
      header={
        <SettingsHeader
          title="Plugins"
          description="Seti's plugin folders and the Claude Code plugins agents load."
          actions={<RefreshButton busy={pluginsLoading} onClick={onRefresh} />}
        />
      }
    >
      <PluginList refreshes={refreshes} onChanged={capabilities.refresh} onLoading={setPluginsLoading} />
    </SettingsBody>
  )
}

/** A page that shows one view of the probe, with its scope and Refresh in the header. */
function ProbedPage({ view, capabilities, onRefresh }: Omit<PageProps, 'refreshes'> & { view: ProbedKind }) {
  const { label, description } = VIEWS[view]
  return (
    <SettingsBody
      header={
        <SettingsHeader
          title={label}
          description={description}
          actions={<ProbedActions capabilities={capabilities} onRefresh={onRefresh} />}
        />
      }
    >
      <ProbedView view={view} capabilities={capabilities} />
    </SettingsBody>
  )
}

/** The pages built on the Claude Code probe; switching between them keeps one probe. */
export function CapabilitiesPages({ page }: { page: ProbedPageKey }) {
  const capabilities = useCapabilities()
  const [refreshes, setRefreshes] = useState(0)
  const refresh = () => {
    setRefreshes((count) => count + 1)
    capabilities.refresh()
  }
  return page === 'plugins' ? (
    <PluginsPage capabilities={capabilities} refreshes={refreshes} onRefresh={refresh} />
  ) : (
    <ProbedPage view={page} capabilities={capabilities} onRefresh={refresh} />
  )
}
