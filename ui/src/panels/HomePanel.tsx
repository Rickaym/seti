import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { PageHeader } from '@/components/crud/PageHeader'
import { Button } from '@/components/ui/button'
import { useArchivedTasks, useTasks } from '@/hooks/useTasks'
import { navigate } from '@/lib/route'
import { openStartPage } from '@/lib/start-context'
import { subtaskRouteId } from '@/lib/subtasks'
import { AgentBoard } from '@/panels/home/AgentBoard'
import { GraphToolbar } from '@/panels/home/GraphToolbar'
import { GraphView } from '@/panels/home/GraphView'
import { HomeMetrics } from '@/panels/home/HomeMetrics'
import { NeedsYouStrip } from '@/panels/home/NeedsYouStrip'
import { NodeCard, type CardContext } from '@/panels/home/NodeCard'
import { buildGraph, type GraphModel, type GraphNodeSpec } from '@/panels/home/graph-model'
import { useGraphFilters } from '@/panels/home/useGraphFilters'
import { useHome } from '@/panels/home/useHome'

function openNode(node: GraphNodeSpec): void {
  if (node.taskId === null) {
    return
  }
  navigate('agents', node.subagent === null ? node.taskId : subtaskRouteId(node.taskId, node.subagent))
}

function graphLabel(model: GraphModel): string {
  const count = (kind: GraphNodeSpec['kind']) => model.nodes.filter((node) => node.kind === kind).length
  const running = model.nodes.filter((node) => node.status === 'running').length
  return `Graph of ${String(count('agent'))} agents, ${String(running)} running, with ${String(count('repo'))} repos, ${String(count('mcp'))} MCP servers and ${String(count('subagent'))} subagents running`
}

function EmptyGraph() {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">
        No agents yet. Each agent you start shows here with its repos and tools.
      </p>
      <Button
        className="pointer-events-auto"
        onClick={() => {
          openStartPage()
        }}
      >
        <Plus />
        New agent
      </Button>
    </div>
  )
}

/** The landing page: a live graph of agents and what they reach, and what they shipped. */
export function HomePanel() {
  const { tasks, loaded } = useTasks()
  const { archived } = useArchivedTasks()
  const { summary } = useHome()
  const [filters, setFilter] = useGraphFilters()
  const [highlight, setHighlight] = useState<string | null>(null)
  const [fitSignal, setFitSignal] = useState(0)
  const model = useMemo(() => buildGraph({ tasks, archived, summary, filters }), [tasks, archived, summary, filters])
  const ctx = useMemo<CardContext>(
    () => ({
      tasks: new Map([...archived, ...tasks].map((task) => [task.id, task])),
      stats: new Map(summary?.agents.map((agent) => [agent.task_id, agent])),
      summary,
      model,
    }),
    [tasks, archived, summary, model],
  )
  const boardTasks = useMemo(
    () => new Map([...(filters.archived ? archived : []), ...tasks].map((task) => [task.id, task])),
    [tasks, archived, filters.archived],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Home"
        actions={
          <GraphToolbar
            filters={filters}
            onChange={setFilter}
            onFit={() => {
              setFitSignal((n) => n + 1)
            }}
          />
        }
      />
      <NeedsYouStrip tasks={tasks} />
      <div className="flex min-h-0 flex-1 max-md:flex-col max-md:overflow-y-auto">
        <div className="relative flex min-h-0 min-w-0 flex-1 max-md:h-[56dvh] max-md:flex-none">
          <GraphView
            className="flex-1"
            model={model}
            label={graphLabel(model)}
            highlight={highlight}
            fitSignal={fitSignal}
            onOpen={openNode}
            renderCard={(node, pinned, close) => (
              <NodeCard
                node={node}
                ctx={ctx}
                onOpen={
                  pinned && node.taskId !== null
                    ? () => {
                        openNode(node)
                      }
                    : null
                }
                onClose={pinned ? close : null}
              />
            )}
          />
          {loaded && tasks.length === 0 && !filters.archived && <EmptyGraph />}
        </div>
        <aside
          aria-label="Metrics"
          className="flex w-80 shrink-0 flex-col gap-6 overflow-y-auto border-l border-border p-4 max-md:w-full max-md:overflow-visible max-md:border-t max-md:border-l-0 max-md:p-3"
        >
          {summary === null ? (
            <p className="text-xs text-muted-foreground">Counting what shipped...</p>
          ) : (
            <>
              <HomeMetrics summary={summary} />
              <AgentBoard
                stats={summary.agents}
                tasks={boardTasks}
                onOpen={(taskId) => {
                  navigate('agents', taskId)
                }}
                onHighlight={setHighlight}
              />
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
