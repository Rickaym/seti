import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import type { GraphEdgeSpec, GraphModel, GraphNodeKind, GraphNodeSpec } from './graph-model'

export type SimNode = SimulationNodeDatum & GraphNodeSpec

export interface SimEdge extends SimulationLinkDatum<SimNode> {
  spec: GraphEdgeSpec
}

const CHARGE: Record<GraphNodeKind, number> = { agent: -260, repo: -180, mcp: -170, subagent: -60, tool: -50 }
const DISTANCE: Record<GraphEdgeSpec['kind'], number> = { repo: 70, mcp: 90, subagent: 26, tool: 22 }
const STRENGTH: Record<GraphEdgeSpec['kind'], number> = { repo: 0.45, mcp: 0.22, subagent: 0.9, tool: 0.9 }
const CENTRE_PULL = 0.045
const SPREAD = 160

/** A stable angle from an id, so the same agents land in the same places on every load. */
function angleOf(id: string): number {
  let hash = 0
  for (const char of id) {
    hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) | 0
  }
  return ((hash >>> 0) % 3600) / 3600
}

/** The node at the other end of an edge from `id`, or null when the edge does not touch it. */
function otherEnd(edge: GraphEdgeSpec, id: string): string | null {
  if (edge.source === id) {
    return edge.target
  }
  return edge.target === id ? edge.source : null
}

const endId = (end: SimEdge['source']) => (typeof end === 'object' ? end.id : String(end))

/** Owns the force layout; nodes keep their positions across data updates. */
export class GraphSim {
  nodes: SimNode[] = []
  edges: SimEdge[] = []
  private byId = new Map<string, SimNode>()
  private edgeIds = new Set<string>()
  private readonly links = forceLink<SimNode, SimEdge>([])
    .id((node) => node.id)
    .distance((edge) => DISTANCE[edge.spec.kind] + this.radiusOf(edge.source) + this.radiusOf(edge.target))
    .strength((edge) => STRENGTH[edge.spec.kind])

  readonly sim: Simulation<SimNode, SimEdge> = forceSimulation<SimNode, SimEdge>([])
    .stop()
    .alphaDecay(0.028)
    .velocityDecay(0.38)
    .force(
      'charge',
      forceManyBody<SimNode>()
        .strength((node) => CHARGE[node.kind])
        .distanceMax(420),
    )
    .force('link', this.links)
    .force(
      'collide',
      forceCollide<SimNode>((node) => node.radius + 7),
    )
    .force('x', forceX<SimNode>(0).strength(CENTRE_PULL))
    .force('y', forceY<SimNode>(0).strength(CENTRE_PULL))

  private radiusOf(end: SimEdge['source']): number {
    return typeof end === 'object' ? end.radius : (this.byId.get(String(end))?.radius ?? 0)
  }

  get(id: string): SimNode | undefined {
    return this.byId.get(id)
  }

  /** Where a new node starts: beside a node it links to, else on a ring by its id. */
  private start(spec: GraphNodeSpec, model: GraphModel): { x: number; y: number } {
    const turn = angleOf(spec.id) * 2 * Math.PI
    for (const edge of model.edges) {
      const near = this.byId.get(otherEnd(edge, spec.id) ?? '')
      if (near?.x !== undefined && near.y !== undefined) {
        return { x: near.x + Math.cos(turn) * 24, y: near.y + Math.sin(turn) * 24 }
      }
    }
    const reach = spec.kind === 'agent' ? SPREAD : SPREAD * 1.6
    return { x: Math.cos(turn) * reach, y: Math.sin(turn) * reach }
  }

  /** Takes a new model, keeping known nodes in place; true when nodes or edges came or went. */
  update(model: GraphModel): boolean {
    const next = new Map<string, SimNode>()
    let changed = model.nodes.length !== this.byId.size
    for (const spec of model.nodes) {
      const known = this.byId.get(spec.id)
      if (known === undefined) {
        changed = true
        next.set(spec.id, { ...spec, ...this.start(spec, model) })
      } else {
        next.set(spec.id, Object.assign(known, spec))
      }
    }
    const edgeIds = new Set(model.edges.map((edge) => edge.id))
    changed ||= edgeIds.size !== this.edgeIds.size || [...edgeIds].some((id) => !this.edgeIds.has(id))
    this.byId = next
    this.edgeIds = edgeIds
    this.nodes = [...next.values()]
    this.edges = model.edges.map((spec) => ({ spec, source: spec.source, target: spec.target }))
    this.sim.nodes(this.nodes)
    this.links.links(this.edges)
    if (changed) {
      this.sim.alpha(Math.max(this.sim.alpha(), 0.6))
    }
    return changed
  }

  /** Ids of a node and its neighbours. */
  around(id: string): Set<string> {
    const near = new Set([id])
    for (const edge of this.edges) {
      const [source, target] = [endId(edge.source), endId(edge.target)]
      if (source === id) {
        near.add(target)
      } else if (target === id) {
        near.add(source)
      }
    }
    return near
  }

  active(): boolean {
    return this.sim.alpha() > this.sim.alphaMin()
  }
}
