import { needsYou } from '@seti/shared'
import { DIM, type Scene } from './graph-scene'
import type { SimNode } from './graph-sim'

const LABEL_FONT = '500 11px "JetBrains Mono Variable", monospace'
const HUB_FONT = '400 10px "JetBrains Mono Variable", monospace'
const LINE_HEIGHT = 13
const PAD = 3
/** Labels show from this zoom; closer in for subagents, which crowd their agent. */
const MIN_K = 0.45
const SUBAGENT_K = 1.1

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

const isHub = (node: SimNode) => node.kind === 'repo' || node.kind === 'mcp' || node.kind === 'tool'

/** Lower draws first and wins a crowded spot: the focus, then agents that need the user. */
function rank(node: SimNode, scene: Scene): number {
  if (scene.focus?.has(node.id) === true) {
    return 0
  }
  const status = node.status === 'archived' ? null : node.status
  if (status !== null && needsYou(status)) {
    return 1
  }
  if (status === 'running') {
    return 2
  }
  return node.kind === 'agent' ? 3 + 1 / (1 + node.radius) : 5
}

function wanted(node: SimNode, scene: Scene): boolean {
  if (scene.focus?.has(node.id) === true) {
    return true
  }
  return scene.view.k >= (node.kind === 'subagent' ? SUBAGENT_K : MIN_K)
}

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** Labels under their nodes, crisp on screen; a label that would overlap a placed one is left out. */
export function drawLabels(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { view, ink } = scene
  const placed: Box[] = []
  const order = scene.nodes
    .filter((node) => wanted(node, scene))
    .map((node) => ({ node, rank: rank(node, scene) }))
    .sort((a, b) => a.rank - b.rank)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 3
  ctx.strokeStyle = ink.background
  for (const { node } of order) {
    const x = (node.x ?? 0) * view.k + view.x
    const y = ((node.y ?? 0) + node.radius) * view.k + view.y + 5
    if (x < -200 || x > scene.width + 200 || y < -40 || y > scene.height + 40) {
      continue
    }
    ctx.font = isHub(node) ? HUB_FONT : LABEL_FONT
    const half = ctx.measureText(node.label).width / 2
    const box = { left: x - half - PAD, top: y - PAD, right: x + half + PAD, bottom: y + LINE_HEIGHT + PAD }
    if (placed.some((other) => overlaps(box, other))) {
      continue
    }
    placed.push(box)
    ctx.globalAlpha = scene.focus === null || scene.focus.has(node.id) ? 1 : DIM
    ctx.fillStyle = isHub(node) ? ink.muted : ink.foreground
    ctx.strokeText(node.label, x, y)
    ctx.fillText(node.label, x, y)
  }
  ctx.globalAlpha = 1
}
