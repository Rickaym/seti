import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { announce, focusInto, panelElement } from './grid-dom'
import {
  COLS,
  movePanel,
  neighbour,
  resizePanel,
  samePanels,
  type Direction,
  type Metrics,
  type Panel,
} from './grid-layout'
import { gridStore } from './grid-store'
import { seti } from './seti'

const FOCUS: { chord: string; direction: Direction }[] = [
  { chord: 'Alt+Left', direction: 'left' },
  { chord: 'Alt+Right', direction: 'right' },
  { chord: 'Alt+Up', direction: 'up' },
  { chord: 'Alt+Down', direction: 'down' },
]

const MOVE: { chord: string; direction: Direction }[] = [
  { chord: 'Alt+Shift+Left', direction: 'left' },
  { chord: 'Alt+Shift+Right', direction: 'right' },
  { chord: 'Alt+Shift+Up', direction: 'up' },
  { chord: 'Alt+Shift+Down', direction: 'down' },
]

const ARROWS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

const EDGES: Record<Direction, string> = {
  left: 'is already at the left edge',
  right: 'is already at the right edge',
  up: 'is already at the top',
  down: 'has nothing below to trade places with',
}

const plural = (n: number, one: string) => `${String(n)} ${one}${n === 1 ? '' : 's'}`

/** Where a panel sits, as a screen reader hears it. */
export const placeText = (p: Panel) => `column ${String(p.x + 1)} of ${String(COLS)}, row ${String(p.y + 1)}`

export const sizeText = (p: Panel) => `${plural(p.w, 'column')} wide, ${plural(p.h, 'row')} tall`

interface PanelKeysOptions {
  /** The panels as shown, which keyboard moves start from. */
  panels: readonly Panel[]
  metrics: Metrics
  locked: boolean
  titleOf: (panel: Panel) => string
  onFocusPanel: (id: string) => void
}

/** Alt+arrows between panels, Alt+Shift+arrows to move one, and arrange mode to resize too. */
export function usePanelKeys({ panels, metrics, locked, titleOf, onFocusPanel }: PanelKeysOptions) {
  const [arranging, setArranging] = useState<string | null>(null)
  const before = useRef<readonly Panel[]>([])
  const latest = useRef({ panels, metrics, titleOf })
  useLayoutEffect(() => {
    latest.current = { panels, metrics, titleOf }
  })

  /** Applies a keyboard step to the focused panel and says what changed. */
  const step = useCallback((id: string, direction: Direction, resize: boolean) => {
    const { panels: current, metrics: m, titleOf: title } = latest.current
    const panel = current.find((p) => p.i === id)
    if (panel === undefined) {
      return
    }
    const next = resize ? resizePanel(current, id, direction, m) : movePanel(current, id, direction)
    const moved = next.find((p) => p.i === id)
    if (samePanels(next, current) || moved === undefined) {
      announce(resize ? `${title(panel)} is ${sizeText(panel)}` : `${title(panel)} ${EDGES[direction]}`)
      return
    }
    gridStore.setPanels(next)
    announce(
      resize
        ? `${title(moved)} is now ${sizeText(moved)}`
        : `${title(moved)} moved ${direction}, to ${placeText(moved)}`,
    )
  }, [])

  seti().keys.useChords([
    ...FOCUS.map(({ chord, direction }) => ({
      chord,
      run: () => {
        const { focused } = gridStore.getSnapshot()
        const next = focused === null ? null : neighbour(latest.current.panels, focused, direction)
        if (next !== null) {
          onFocusPanel(next.i)
          requestAnimationFrame(() => {
            focusInto(next.i)
          })
        }
      },
    })),
    ...MOVE.map(({ chord, direction }) => ({
      chord,
      run: () => {
        const { focused } = gridStore.getSnapshot()
        if (focused === null) {
          return
        }
        if (locked) {
          announce('The grid layout is locked')
          return
        }
        step(focused, direction, false)
      },
    })),
  ])

  const arrangingRef = useRef<string | null>(null)
  const arrange = useCallback(
    (id: string) => {
      if (locked) {
        return
      }
      before.current = gridStore.getSnapshot().panels
      arrangingRef.current = id
      onFocusPanel(id)
      setArranging(id)
      requestAnimationFrame(() => {
        panelElement(id)?.focus({ preventScroll: true })
      })
      const panel = latest.current.panels.find((p) => p.i === id)
      const name = panel === undefined ? 'Panel' : latest.current.titleOf(panel)
      announce(`Arranging ${name}. Arrows move it, Shift+Arrows resize it, Enter keeps, Escape cancels.`)
    },
    [locked, onFocusPanel],
  )

  useEffect(() => {
    const finish = (id: string, keep: boolean) => {
      arrangingRef.current = null
      setArranging(null)
      if (!keep) {
        gridStore.setPanels(before.current)
      }
      announce(keep ? 'Layout kept' : 'Arranging cancelled')
      requestAnimationFrame(() => {
        focusInto(id)
      })
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const id = arrangingRef.current
      if (id === null) {
        return
      }
      const direction = ARROWS[event.key]
      const plain = !event.altKey && !event.ctrlKey && !event.metaKey
      if (direction !== undefined && plain) {
        step(id, direction, event.shiftKey)
      } else if (event.key === 'Enter' || event.key === 'Escape') {
        finish(id, event.key === 'Enter')
      } else {
        if (event.key === 'Tab') {
          finish(id, true)
        }
        return
      }
      event.preventDefault()
      event.stopPropagation()
    }
    const onPointerDown = () => {
      if (arrangingRef.current !== null) {
        finish(arrangingRef.current, true)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [step])

  return { arranging, arrange }
}
