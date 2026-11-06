import {
  listedStatus,
  type ArchivedTaskEntry,
  type HomeAgentStats,
  type HomeSummary,
  type TaskListEntry,
} from '@seti/shared'
import { ArrowUpRight, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { agentColorAttr } from '@/lib/agent-color-sheet'
import { usd } from '@/lib/money'
import { durationLabel } from '@/lib/time'
import { cn } from '@/lib/utils'
import { ArchivedLight, StatusLight } from '@/panels/tasks/StatusPill'
import { shortRepoLabel } from '@/panels/tasks/agent-list'
import { reasonLine } from '@/panels/tasks/status-label'
import type { GraphModel, GraphNodeSpec } from './graph-model'

export interface CardContext {
  tasks: ReadonlyMap<string, TaskListEntry | ArchivedTaskEntry>
  stats: ReadonlyMap<string, HomeAgentStats>
  summary: HomeSummary | null
  model: GraphModel
}

/** A labelled number in the card's grid. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-2xs text-muted-foreground uppercase">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
}

function AgentFacts({ stats }: { stats: HomeAgentStats | undefined }) {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
      <Fact label="Merged 30d" value={String(stats?.merged_30d ?? 0)} />
      <Fact label="Turns 30d" value={String(stats?.turns_30d ?? 0)} />
      <Fact label="Cost 30d" value={usd(stats?.cost_30d_usd ?? 0)} />
      <Fact label="Running" value={durationLabel(stats?.run_ms_30d ?? 0)} />
    </dl>
  )
}

function AgentBody({ task, ctx }: { task: TaskListEntry | ArchivedTaskEntry; ctx: CardContext }) {
  const stats = ctx.stats.get(task.id)
  const archived = 'archive' in task
  const status = archived ? null : listedStatus(task)
  const reason = archived || status === null ? null : reasonLine(task, status)
  const running = archived ? 0 : task.running_subtasks.length
  const servers = stats?.mcp.map((use) => use.server) ?? []
  return (
    <>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {status === null ? <ArchivedLight /> : <StatusLight status={status} place="home" subagents={running} />}
        <span className="truncate">{shortRepoLabel(task)}</span>
      </div>
      {reason !== null && <p className="line-clamp-2 text-muted-foreground">{reason}</p>}
      <AgentFacts stats={stats} />
      {(servers.length > 0 || running > 0) && (
        <p className="text-muted-foreground">
          {running > 0 && `${String(running)} ${running === 1 ? 'subagent' : 'subagents'} running. `}
          {servers.length > 0 && `Uses ${servers.join(', ')}.`}
        </p>
      )}
    </>
  )
}

function hubAgents(node: GraphNodeSpec, ctx: CardContext): string[] {
  return ctx.model.edges
    .filter((edge) => edge.target === node.id && edge.source.startsWith('agent:'))
    .map((edge) => ctx.tasks.get(edge.source.slice('agent:'.length))?.title ?? '')
    .filter((title) => title !== '')
}

function HubBody({ node, ctx }: { node: GraphNodeSpec; ctx: CardContext }) {
  const agents = hubAgents(node, ctx)
  const calls = node.kind === 'mcp' ? ctx.model.edges.filter((edge) => edge.target === node.id) : []
  const total = calls.reduce((sum, edge) => sum + (edge.live ? 0 : edge.weight), 0)
  const live = calls.filter((edge) => edge.live).length
  return (
    <>
      <p className="text-muted-foreground">
        {node.kind === 'repo' ? 'Repo' : 'MCP server'}, {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
        {node.kind === 'mcp' && `, ${String(total)} calls in 30 days`}
        {live > 0 && `, ${String(live)} now`}
      </p>
      {agents.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {agents.slice(0, 5).map((title) => (
            <li key={title} className="truncate">
              {title}
            </li>
          ))}
          {agents.length > 5 && <li className="text-muted-foreground">and {agents.length - 5} more</li>}
        </ul>
      )}
    </>
  )
}

function RunBody({ node, ctx }: { node: GraphNodeSpec; ctx: CardContext }) {
  const agent = node.taskId === null ? undefined : ctx.tasks.get(node.taskId)
  const what = node.kind === 'subagent' ? 'Subagent' : 'Tool call'
  return (
    <p className="text-muted-foreground">
      {what} running now{agent === undefined ? '' : ` in ${agent.title}`}.
    </p>
  )
}

function body(node: GraphNodeSpec, ctx: CardContext): ReactNode {
  const task = node.taskId === null ? undefined : ctx.tasks.get(node.taskId)
  if (node.kind === 'agent' && task !== undefined) {
    return <AgentBody task={task} ctx={ctx} />
  }
  if (node.kind === 'repo' || node.kind === 'mcp') {
    return <HubBody node={node} ctx={ctx} />
  }
  return <RunBody node={node} ctx={ctx} />
}

/** The small card a hovered or tapped node shows; a tapped one can be closed or open its agent. */
export function NodeCard({
  node,
  ctx,
  onOpen,
  onClose,
}: {
  node: GraphNodeSpec
  ctx: CardContext
  onOpen: (() => void) | null
  onClose: (() => void) | null
}) {
  const task = node.taskId === null ? undefined : ctx.tasks.get(node.taskId)
  const title = node.kind === 'agent' && task !== undefined ? task.title : node.label
  return (
    <div
      role="dialog"
      aria-label={title}
      className="flex flex-col gap-2 border border-border bg-popover p-3 text-xs text-popover-foreground shadow-md"
    >
      <div className="flex items-start gap-2">
        {node.color !== null && (
          <span {...agentColorAttr(node.color)} aria-hidden className="mt-1 size-2.5 shrink-0 bg-(--agent-stripe)" />
        )}
        <h3 className={cn('line-clamp-2 min-w-0 flex-1 font-semibold', node.kind !== 'agent' && 'break-all')}>
          {title}
        </h3>
        {onClose !== null && (
          <Button variant="ghost" size="icon-xs" aria-label="Close" className="-m-1 shrink-0" onClick={onClose}>
            <X />
          </Button>
        )}
      </div>
      {body(node, ctx)}
      {onOpen !== null && (
        <Button size="sm" className="self-start" onClick={onOpen}>
          <ArrowUpRight />
          Open
        </Button>
      )}
    </div>
  )
}
