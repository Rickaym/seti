import { drawScene } from './graph-draw'
import { attachGestures, type GestureTarget } from './graph-gestures'
import type { GraphInk } from './graph-ink'
import type { GraphModel } from './graph-model'
import type { View } from './graph-scene'
import { GraphSim, type SimNode } from './graph-sim'

export interface GraphEvents {
  /** The node under a mouse pointer, or null when it leaves every node. */
  onHover: (node: SimNode | null) => void
  /** A click or tap; `touch` tells a finger from a mouse, null node for the background. */
  onTap: (node: SimNode | null, touch: boolean) => void
  /** After each drawn frame, so an overlay can follow a moving node. */
  onFrame: () => void
}

const FIT_PAD = 48
const MIN_K = 0.2
const MAX_K = 4
/** Layout steps run before the first frame, so the graph opens close to settled. */
const WARM_TICKS = 80
/** A reduced-motion layout settles off screen in one go. */
const SETTLE_TICKS = 300

const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k))

/** Draws the Home graph on a canvas and runs its layout, pan, zoom, drag and taps. */
export class GraphCanvas implements GestureTarget {
  readonly sim = new GraphSim()
  view: View = { x: 0, y: 0, k: 1 }
  private ink: GraphInk | null = null
  private ordered: SimNode[] = []
  private live = false
  private focusId: string | null = null
  private focus: ReadonlySet<string> | null = null
  private autoFit = true
  private frame = 0
  private width = 0
  private height = 0
  private dpr = 1
  private readonly context: CanvasRenderingContext2D | null
  private readonly cleanups: (() => void)[] = []
  private readonly canvas: HTMLCanvasElement
  private readonly events: GraphEvents
  private motion: boolean

  constructor(canvas: HTMLCanvasElement, events: GraphEvents, motion: boolean) {
    this.canvas = canvas
    this.events = events
    this.motion = motion
    this.context = canvas.getContext('2d')
    const resize = new ResizeObserver(() => {
      this.resize()
    })
    resize.observe(canvas)
    this.cleanups.push(() => {
      resize.disconnect()
    })
    this.cleanups.push(attachGestures(canvas, this))
    this.resize()
  }

  destroy(): void {
    cancelAnimationFrame(this.frame)
    for (const cleanup of this.cleanups) {
      cleanup()
    }
  }

  setInk(ink: GraphInk | null): void {
    this.ink = ink
    this.request()
  }

  setMotion(motion: boolean): void {
    this.motion = motion
    this.request()
  }

  setModel(model: GraphModel): void {
    const first = this.sim.nodes.length === 0
    const changed = this.sim.update(model)
    this.ordered = [...this.sim.nodes].sort((a, b) => Number(a.kind === 'agent') - Number(b.kind === 'agent'))
    this.live = model.edges.some((edge) => edge.live)
    if (this.focusId !== null) {
      this.setFocus(this.sim.get(this.focusId) === undefined ? null : this.focusId)
    }
    if (changed && (first || !this.motion)) {
      this.sim.sim.tick(this.motion ? WARM_TICKS : SETTLE_TICKS)
      this.fitNow()
    }
    this.request()
  }

  /** Dims all but this node and its neighbours; null shows everything. */
  setFocus(id: string | null): void {
    this.focusId = id
    this.focus = id === null ? null : this.sim.around(id)
    this.request()
  }

  /** Frames every node and keeps doing so while the layout settles, until the user moves the view. */
  fit(): void {
    this.autoFit = true
    this.fitNow()
    this.request()
  }

  /** Where a node shows, in CSS pixels from the canvas corner. */
  screenOf(id: string): { x: number; y: number; r: number } | null {
    const node = this.sim.get(id)
    if (node?.x === undefined || node.y === undefined) {
      return null
    }
    return {
      x: node.x * this.view.k + this.view.x,
      y: node.y * this.view.k + this.view.y,
      r: node.radius * this.view.k,
    }
  }

  nodeAt(px: number, py: number, slop: number): SimNode | null {
    const [wx, wy] = this.toWorld(px, py)
    let best: SimNode | null = null
    let bestGap = Number.POSITIVE_INFINITY
    for (const node of this.sim.nodes) {
      const gap = Math.hypot((node.x ?? 0) - wx, (node.y ?? 0) - wy) - node.radius
      if (gap < slop / this.view.k && gap < bestGap) {
        best = node
        bestGap = gap
      }
    }
    return best
  }

  toWorld(px: number, py: number): [number, number] {
    return [(px - this.view.x) / this.view.k, (py - this.view.y) / this.view.k]
  }

  /** Moves the view by a screen offset and scales it about a screen point. */
  moveView(dx: number, dy: number, scale = 1, about: [number, number] = [0, 0]): void {
    this.autoFit = false
    const k = clampK(this.view.k * scale)
    const applied = k / this.view.k
    this.view = {
      k,
      x: about[0] - (about[0] - this.view.x) * applied + dx,
      y: about[1] - (about[1] - this.view.y) * applied + dy,
    }
    this.request()
  }

  /** Pins a dragged node under the pointer and wakes the layout around it; null lets go. */
  drag(dragged: SimNode, px: number | null, py: number | null): void {
    const node = this.sim.get(dragged.id)
    if (node === undefined) {
      return
    }
    const sim = this.sim.sim
    if (px === null || py === null) {
      node.fx = null
      node.fy = null
      sim.alphaTarget(0)
    } else {
      const [wx, wy] = this.toWorld(px, py)
      node.fx = wx
      node.fy = wy
      sim.alphaTarget(0.25)
      sim.alpha(Math.max(sim.alpha(), 0.25))
    }
    this.request()
  }

  hover(node: SimNode | null): void {
    this.events.onHover(node)
  }

  tap(node: SimNode | null, touch: boolean): void {
    this.events.onTap(node, touch)
  }

  private resize(): void {
    const box = this.canvas.getBoundingClientRect()
    this.dpr = Math.min(window.devicePixelRatio, 2)
    this.width = box.width
    this.height = box.height
    this.canvas.width = Math.round(box.width * this.dpr)
    this.canvas.height = Math.round(box.height * this.dpr)
    if (this.autoFit) {
      this.fitNow()
    }
    this.request()
  }

  private fitNow(): void {
    const placed = this.sim.nodes.filter((node) => node.x !== undefined && node.y !== undefined)
    if (placed.length === 0 || this.width === 0 || this.height === 0) {
      return
    }
    const xs = placed.flatMap((node) => [(node.x ?? 0) - node.radius, (node.x ?? 0) + node.radius])
    const ys = placed.flatMap((node) => [(node.y ?? 0) - node.radius, (node.y ?? 0) + node.radius + 16])
    const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const k = clampK(
      Math.min(
        (this.width - 2 * FIT_PAD) / Math.max(right - left, 1),
        (this.height - 2 * FIT_PAD) / Math.max(bottom - top, 1),
        1.6,
      ),
    )
    this.view = { k, x: this.width / 2 - ((left + right) / 2) * k, y: this.height / 2 - ((top + bottom) / 2) * k }
  }

  private animating(): boolean {
    return this.sim.active() || (this.motion && (this.live || this.ordered.some((n) => n.status === 'running')))
  }

  private request(): void {
    if (this.frame === 0) {
      this.frame = requestAnimationFrame((time) => {
        this.frame = 0
        this.draw(time)
      })
    }
  }

  private draw(time: number): void {
    if (this.sim.active()) {
      this.sim.sim.tick()
      if (this.autoFit) {
        this.fitNow()
      }
    }
    if (this.context !== null && this.ink !== null) {
      drawScene(this.context, {
        nodes: this.ordered,
        edges: this.sim.edges,
        ink: this.ink,
        view: this.view,
        width: this.width,
        height: this.height,
        dpr: this.dpr,
        time,
        motion: this.motion,
        focus: this.focus,
      })
    }
    this.events.onFrame()
    if (this.animating()) {
      this.request()
    }
  }
}
