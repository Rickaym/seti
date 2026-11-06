import type { GraphInk } from './graph-ink'
import type { SimEdge, SimNode } from './graph-sim'

/** How strongly everything outside the focus fades. */
export const DIM = 0.18

/** Pan and zoom: a world point p shows at p * k + (x, y) in CSS pixels. */
export interface View {
  x: number
  y: number
  k: number
}

export interface Scene {
  /** In drawing order, agents last so they sit above the hubs. */
  nodes: readonly SimNode[]
  edges: readonly SimEdge[]
  ink: GraphInk
  view: View
  width: number
  height: number
  dpr: number
  /** Milliseconds, which drive the marching dashes and the running pulse. */
  time: number
  motion: boolean
  /** The hovered or picked node and its neighbours; everything else dims. */
  focus: ReadonlySet<string> | null
}
