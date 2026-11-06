import {
  listedStatus,
  type AgentColor,
  type ArchivedTaskEntry,
  type HomeAgentStats,
  type HomeSummary,
  type SubtaskBrief,
  type TaskDisplayStatus,
  type TaskListEntry,
} from '@seti/shared'

export type GraphNodeKind = 'agent' | 'subagent' | 'repo' | 'mcp' | 'tool'

/** What a node stands for and how it draws; positions live in the renderer. */
export interface GraphNodeSpec {
  id: string
  kind: GraphNodeKind
  label: string
  radius: number
  /** The agent colour of an agent and of the subagents and tools it runs. */
  color: AgentColor | null
  /** The agent an agent, subagent or tool node belongs to. */
  taskId: string | null
  /** An agent's status as Seti shows it, or archived. */
  status: TaskDisplayStatus | 'archived' | null
  /** A subagent's Agent call id. */
  subagent: string | null
}

export interface GraphEdgeSpec {
  id: string
  source: string
  target: string
  kind: 'repo' | 'mcp' | 'subagent' | 'tool'
  /** A subagent or tool call that runs now; it animates. */
  live: boolean
  /** Calls behind an MCP edge, which thicken it. */
  weight: number
}

export interface GraphModel {
  nodes: GraphNodeSpec[]
  edges: GraphEdgeSpec[]
}

export interface GraphFilters {
  repos: boolean
  tools: boolean
  subagents: boolean
  archived: boolean
  /** Size agents by what they cost over 30 days instead of how many turns they ran. */
  cost: boolean
}

export const DEFAULT_FILTERS: GraphFilters = { repos: true, tools: true, subagents: true, archived: false, cost: false }

interface GraphInput {
  tasks: readonly TaskListEntry[]
  archived: readonly ArchivedTaskEntry[]
  summary: HomeSummary | null
  filters: GraphFilters
}

const AGENT_MIN = 9
const AGENT_SPREAD = 13
const LABEL_MAX = 28

const agentNodeId = (taskId: string) => `agent:${taskId}`
const subagentNodeId = (taskId: string, toolUseId: string) => `sub:${taskId}:${toolUseId}`

const clip = (text: string, max = LABEL_MAX) => (text.length > max ? `${text.slice(0, max - 1)}...` : text)

const lastSegment = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path

const subagentLabel = (subtask: SubtaskBrief) =>
  subtask.description === '' ? (subtask.subagent_type ?? 'subagent') : subtask.description

class Builder {
  readonly nodes = new Map<string, GraphNodeSpec>()
  readonly edges = new Map<string, GraphEdgeSpec>()

  node(spec: GraphNodeSpec): void {
    if (!this.nodes.has(spec.id)) {
      this.nodes.set(spec.id, spec)
    }
  }

  edge(spec: Omit<GraphEdgeSpec, 'id'>): void {
    const id = `${spec.source}>${spec.target}`
    const known = this.edges.get(id)
    this.edges.set(id, {
      ...spec,
      id,
      live: spec.live || (known?.live ?? false),
      weight: spec.weight + (known?.weight ?? 0),
    })
  }

  hub(id: string, kind: 'repo' | 'mcp', label: string): void {
    this.node({ id, kind, label, radius: 7, color: null, taskId: null, status: null, subagent: null })
  }
}

/** What sizes an agent: its turns or its cost over 30 days. */
const sizeOf = (stats: HomeAgentStats | undefined, cost: boolean) => {
  if (stats === undefined) {
    return 0
  }
  return cost ? stats.cost_30d_usd : stats.turns_30d
}

const agentRadius = (value: number, top: number) => AGENT_MIN + AGENT_SPREAD * Math.sqrt(top > 0 ? value / top : 0)

function addSubagents(b: Builder, task: TaskListEntry): void {
  const id = agentNodeId(task.id)
  const running = new Set(task.running_subtasks.map((subtask) => subtask.tool_use_id))
  for (const subtask of task.running_subtasks) {
    const sub = subagentNodeId(task.id, subtask.tool_use_id)
    const nested = subtask.parent_tool_use_id !== null && running.has(subtask.parent_tool_use_id)
    const parent = nested ? subagentNodeId(task.id, subtask.parent_tool_use_id ?? '') : id
    b.node({
      id: sub,
      kind: 'subagent',
      label: clip(subagentLabel(subtask)),
      radius: 5,
      color: task.color,
      taskId: task.id,
      status: null,
      subagent: subtask.tool_use_id,
    })
    b.edge({ source: parent, target: sub, kind: 'subagent', live: true, weight: 1 })
  }
}

function addAgent(b: Builder, task: TaskListEntry | ArchivedTaskEntry, radius: number, input: GraphInput): void {
  const id = agentNodeId(task.id)
  const status = 'archive' in task ? 'archived' : listedStatus(task)
  b.node({
    id,
    kind: 'agent',
    label: clip(task.title),
    radius,
    color: task.color,
    taskId: task.id,
    status,
    subagent: null,
  })
  if (input.filters.repos) {
    for (const repo of task.repos) {
      b.hub(`repo:${repo.id}`, 'repo', lastSegment(repo.slug))
      b.edge({ source: id, target: `repo:${repo.id}`, kind: 'repo', live: false, weight: 1 })
    }
  }
  if (input.filters.subagents && !('archive' in task)) {
    addSubagents(b, task)
  }
}

function addMcpUse(b: Builder, summary: HomeSummary): void {
  for (const stats of summary.agents) {
    const id = agentNodeId(stats.task_id)
    if (!b.nodes.has(id)) {
      continue
    }
    for (const use of stats.mcp) {
      b.hub(`mcp:${use.server}`, 'mcp', use.server)
      b.edge({ source: id, target: `mcp:${use.server}`, kind: 'mcp', live: false, weight: use.calls })
    }
  }
}

function addLiveCalls(b: Builder, summary: HomeSummary): void {
  for (const call of summary.live) {
    const agent = b.nodes.get(agentNodeId(call.task_id))
    if (agent === undefined) {
      continue
    }
    const sub = call.subagent === null ? null : subagentNodeId(call.task_id, call.subagent)
    const source = sub !== null && b.nodes.has(sub) ? sub : agent.id
    if (call.server !== null) {
      b.hub(`mcp:${call.server}`, 'mcp', call.server)
      b.edge({ source, target: `mcp:${call.server}`, kind: 'mcp', live: true, weight: 1 })
      continue
    }
    const tool = `tool:${source}:${call.tool}`
    b.node({
      id: tool,
      kind: 'tool',
      label: call.tool,
      radius: 4,
      color: agent.color,
      taskId: call.task_id,
      status: null,
      subagent: null,
    })
    b.edge({ source, target: tool, kind: 'tool', live: true, weight: 1 })
  }
}

/** The nodes and edges the Home graph draws, from the agent list and the Home summary. */
export function buildGraph(input: GraphInput): GraphModel {
  const stats = new Map(input.summary?.agents.map((agent) => [agent.task_id, agent]))
  const shown: (TaskListEntry | ArchivedTaskEntry)[] = [
    ...input.tasks,
    ...(input.filters.archived ? input.archived : []),
  ]
  const size = (taskId: string) => sizeOf(stats.get(taskId), input.filters.cost)
  const top = Math.max(0, ...shown.map((task) => size(task.id)))
  const b = new Builder()
  for (const task of shown) {
    addAgent(b, task, agentRadius(size(task.id), top), input)
  }
  if (input.summary !== null && input.filters.tools) {
    addMcpUse(b, input.summary)
    addLiveCalls(b, input.summary)
  }
  return { nodes: [...b.nodes.values()], edges: [...b.edges.values()] }
}
