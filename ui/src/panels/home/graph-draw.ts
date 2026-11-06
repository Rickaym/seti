import { needsYou, type TaskDisplayStatus } from '@seti/shared'
import type { GraphInk } from './graph-ink'
import { drawLabels } from './graph-labels'
import { DIM, type Scene } from './graph-scene'
import type { SimEdge, SimNode } from './graph-sim'

const GRID = 40
/** The grid's dots sit back behind everything else. */
const GRID_ALPHA = 0.7

const nodeOf = (end: SimEdge['source']): SimNode | null => (typeof end === 'object' ? end : null)

function drawGrid(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { view, width, height, ink } = scene
  if (view.k < 0.4) {
    return
  }
  const step = GRID * view.k
  ctx.fillStyle = ink.border
  ctx.globalAlpha = GRID_ALPHA
  for (let x = view.x % step; x < width; x += step) {
    for (let y = view.y % step; y < height; y += step) {
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1)
    }
  }
  ctx.globalAlpha = 1
}

interface EdgeStyle {
  colour: string
  alpha: number
  /** In screen pixels. */
  width: number
}

/** Live edges take their agent's colour; MCP edges thicken with the calls behind them. */
function edgeStyle(edge: SimEdge, source: SimNode, ink: GraphInk): EdgeStyle {
  if (edge.spec.live) {
    return { colour: ink.agent(source.color), alpha: 0.95, width: 1.75 }
  }
  if (edge.spec.kind === 'mcp') {
    return { colour: ink.muted, alpha: 0.32, width: 1 + Math.log2(1 + edge.spec.weight) / 3 }
  }
  return { colour: ink.muted, alpha: 0.6, width: 1 }
}

function drawEdges(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { k } = scene.view
  const offset = scene.motion ? -(scene.time / 40) / k : 0
  for (const edge of scene.edges) {
    const [source, target] = [nodeOf(edge.source), nodeOf(edge.target)]
    if (source === null || target === null) {
      continue
    }
    const style = edgeStyle(edge, source, scene.ink)
    const focused = scene.focus === null || (scene.focus.has(source.id) && scene.focus.has(target.id))
    ctx.globalAlpha = focused ? style.alpha : style.alpha * DIM
    ctx.strokeStyle = style.colour
    ctx.lineWidth = style.width / k
    ctx.setLineDash(edge.spec.live ? [5 / k, 4 / k] : [])
    ctx.lineDashOffset = edge.spec.live ? offset : 0
    ctx.beginPath()
    ctx.moveTo(source.x ?? 0, source.y ?? 0)
    ctx.lineTo(target.x ?? 0, target.y ?? 0)
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1
}

function ringColour(status: TaskDisplayStatus, ink: GraphInk): string | null {
  if (status === 'running') {
    return ink.primary
  }
  if (status === 'error') {
    return ink.destructive
  }
  if (needsYou(status)) {
    return ink.warning
  }
  return status === 'complete' ? ink.success : null
}

/** The status glyphs of the agent list, so a status never rests on colour alone. */
function glyph(
  ctx: CanvasRenderingContext2D,
  status: TaskDisplayStatus,
  at: { x: number; y: number; s: number },
): void {
  const { x, y, s } = at
  ctx.beginPath()
  if (status === 'blocked') {
    ctx.moveTo(x, y - s)
    ctx.lineTo(x + s, y)
    ctx.lineTo(x, y + s)
    ctx.lineTo(x - s, y)
  } else if (status === 'asking') {
    ctx.moveTo(x - s, y - s)
    ctx.lineTo(x + s, y - s)
    ctx.lineTo(x + s, y + s * 0.5)
    ctx.lineTo(x, y + s * 0.5)
    ctx.lineTo(x - s * 0.4, y + s)
    ctx.lineTo(x - s * 0.4, y + s * 0.5)
    ctx.lineTo(x - s, y + s * 0.5)
  } else {
    ctx.rect(x - s, y - s, 2 * s, 2 * s)
  }
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
}

function drawAgent(ctx: CanvasRenderingContext2D, node: SimNode, scene: Scene): void {
  const { ink } = scene
  const { k } = scene.view
  const [x, y, r] = [node.x ?? 0, node.y ?? 0, node.radius]
  const status = node.status === 'archived' || node.status === null ? null : node.status
  const ring = status === null ? null : ringColour(status, ink)
  if (ring !== null && status !== null) {
    const pulse = status === 'running' && scene.motion ? 0.55 + 0.4 * Math.sin(scene.time / 260) : 0.85
    ctx.save()
    ctx.globalAlpha *= pulse
    ctx.strokeStyle = ring
    ctx.lineWidth = 2 / k
    ctx.beginPath()
    ctx.arc(x, y, r + 3.5 / k, 0, 2 * Math.PI)
    ctx.stroke()
    ctx.restore()
  }
  ctx.fillStyle = node.status === 'archived' ? ink.muted : ink.agent(node.color)
  ctx.strokeStyle = ink.background
  ctx.lineWidth = 1.5 / k
  ctx.beginPath()
  ctx.arc(x, y, r, 0, 2 * Math.PI)
  ctx.fill()
  ctx.stroke()
  if (status !== null && status !== 'running' && ring !== null) {
    ctx.fillStyle = ring
    ctx.strokeStyle = ink.background
    ctx.lineWidth = 1.5 / k
    glyph(ctx, status, { x: x + r * 0.75, y: y + r * 0.75, s: 4 / k })
  }
}

function hexagon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6
    ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a))
  }
  ctx.closePath()
}

function drawNode(ctx: CanvasRenderingContext2D, node: SimNode, scene: Scene): void {
  const { ink } = scene
  const { k } = scene.view
  const [x, y, r] = [node.x ?? 0, node.y ?? 0, node.radius]
  ctx.globalAlpha =
    (scene.focus === null || scene.focus.has(node.id) ? 1 : DIM) * (node.status === 'archived' ? 0.5 : 1)
  ctx.lineWidth = 1.25 / k
  switch (node.kind) {
    case 'agent':
      drawAgent(ctx, node, scene)
      return
    case 'subagent':
      ctx.fillStyle = ink.background
      ctx.strokeStyle = ink.agent(node.color)
      ctx.lineWidth = 2 / k
      ctx.beginPath()
      ctx.arc(x, y, r, 0, 2 * Math.PI)
      ctx.fill()
      ctx.stroke()
      return
    case 'tool':
      ctx.fillStyle = ink.agent(node.color)
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r)
      return
    case 'repo':
      ctx.fillStyle = ink.card
      ctx.strokeStyle = ink.muted
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r)
      ctx.strokeRect(x - r, y - r, 2 * r, 2 * r)
      return
    case 'mcp':
      ctx.fillStyle = ink.accent
      ctx.strokeStyle = ink.muted
      hexagon(ctx, x, y, r + 1)
      ctx.fill()
      ctx.stroke()
  }
}

/** Draws one frame: the grid, edges and nodes in the world, then the labels crisp on screen. */
export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { dpr, view } = scene
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, scene.width, scene.height)
  drawGrid(ctx, scene)
  ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y)
  drawEdges(ctx, scene)
  for (const node of scene.nodes) {
    drawNode(ctx, node, scene)
  }
  ctx.globalAlpha = 1
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawLabels(ctx, scene)
}
