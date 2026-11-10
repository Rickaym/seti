import type { ModAgentsLayoutProps as AgentsLayoutProps, TerminalRef } from '@seti/mod-api'
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { EventCallback, Layout, LayoutItem } from 'react-grid-layout'
import { EmptyGrid } from './CellPicker'
import { GridCell } from './GridCell'
import { GridToolbar } from './GridToolbar'
import { ScreenSnaps } from './ScreenSnaps'
import { TerminalCell } from './TerminalCell'
import { arranger } from './commands'
import { announce, ANNOUNCER_ID, connectionProtocol, focusInto, revealPanel, showInAddress, useRoom } from './grid-dom'
import { addPanel, COLS, fit, GAP, metrics, ROWS, settle, withRects, type Panel, type Rect } from './grid-layout'
import { gridStore, useGrid, useGridSync } from './grid-store'
import { livePanels, streamBudget } from './grid-streams'
import { FilesDockHost } from './parts'
import { cn, seti } from './seti'
import { addTerminalTile, terminalInPanel, terminalToGrid, useRoutedTile } from './tiles'
import { placeText, sizeText, usePanelKeys } from './usePanelKeys'

const GridLayout = lazy(async () => import('react-grid-layout').then((m) => ({ default: m.GridLayout })))

/** Presses on these stay with the control instead of dragging the panel. */
const NO_DRAG = 'button, a, input, textarea, select, [role="menuitem"], [role="combobox"], [data-no-drag]'

const RESIZE_HANDLES = ['s', 'e', 'w', 'se', 'sw'] as const

/** Shows the agent the address names: focuses its panel, or adds one at the next free place. */
function useRoutePlacement(routeId: string | null, ready: boolean): void {
  useEffect(() => {
    if (routeId === null || !ready) {
      return
    }
    const id = gridStore.open(routeId)
    gridStore.focus(id)
    requestAnimationFrame(() => {
      revealPanel(id)
    })
  }, [routeId, ready])
}

const dragHasAgent = (event: DragEvent) => event.dataTransfer?.types.includes(seti().agents.DRAG_TYPE) === true

const emptyPanelUnder = (target: EventTarget | null) =>
  target instanceof Element ? target.closest('[data-grid-empty]')?.getAttribute('data-grid-panel') : undefined

/** Agents as panels that drag, resize and reflow on a column grid, each a full agent view. */
export const AgentGrid = memo(function AgentGridView({
  tasks,
  loaded,
  routeId,
  subId,
  terminalId,
  onChanged,
  onSubtasks,
}: AgentsLayoutProps) {
  const { panels, focused, recent, locked, perScreen } = useGrid()
  const synced = useGridSync()
  const area = useRef<HTMLDivElement>(null)
  const room = useRoom(area)
  const measured = room.width > 0 && room.height > 0
  const [picking, setPicking] = useState<string | null>(null)
  const [budget] = useState(() => streamBudget(connectionProtocol()))
  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])

  const m = useMemo(() => metrics(room), [room])
  useLayoutEffect(() => {
    gridStore.measure(room)
  }, [room])
  const shown = useMemo(() => fit(panels, m), [panels, m])

  useEffect(() => {
    if (!loaded || !synced) {
      return
    }
    gridStore.prune(new Set(byId.keys()))
    if (routeId !== null && !byId.has(routeId)) {
      showInAddress(null)
    }
  }, [loaded, synced, byId, routeId, panels])
  useRoutePlacement(routeId, synced && measured && routeId !== null && byId.has(routeId))
  useRoutedTile(terminalId)
  useEffect(() => {
    seti().panels.setLandingArea((root) => {
      const id = gridStore.getSnapshot().focused
      return id === null ? root : root.querySelector<HTMLElement>(`[data-grid-panel="${id}"]`)
    })
    return () => {
      seti().panels.setLandingArea(null)
    }
  }, [])

  const onFocusPanel = useCallback((id: string) => {
    const current = gridStore.getSnapshot()
    if (current.focused !== id) {
      gridStore.focus(id)
      showInAddress(current.panels.find((panel) => panel.i === id)?.agent ?? null)
    }
  }, [])

  const onPick = useCallback((id: string, agent: string | null) => {
    setPicking(null)
    gridStore.assign(id, agent)
    gridStore.focus(id)
    showInAddress(agent)
    requestAnimationFrame(() => {
      focusInto(id)
    })
  }, [])

  const titleOf = useCallback(
    (panel: Panel) => {
      if (panel.terminal !== undefined) {
        return panel.terminal.name
      }
      return panel.agent === null ? 'Empty panel' : (byId.get(panel.agent)?.title ?? 'Agent')
    },
    [byId],
  )

  const onPickTerminal = useCallback((id: string, existing?: TerminalRef) => {
    setPicking(null)
    terminalInPanel(id, existing)
  }, [])

  const onRemove = useCallback(
    (id: string) => {
      const panel = gridStore.getSnapshot().panels.find((p) => p.i === id)
      gridStore.remove(id)
      const next = gridStore.getSnapshot().focused
      showInAddress(gridStore.getSnapshot().panels.find((p) => p.i === next)?.agent ?? null)
      if (panel !== undefined) {
        announce(`Removed ${titleOf(panel)} from the grid`)
      }
    },
    [titleOf],
  )

  const { arranging, arrange } = usePanelKeys({ panels: shown, metrics: m, locked, titleOf, onFocusPanel })
  useEffect(() => {
    gridStore.hold('arrange', arranging !== null)
  }, [arranging])

  const live = useMemo(() => livePanels(shown, { focused, recent, budget }), [shown, focused, recent, budget])
  const placed = useMemo(
    () => new Set(panels.flatMap((panel) => (panel.agent === null ? [] : [panel.agent]))),
    [panels],
  )

  const commit = useCallback(
    (verb: 'moved' | 'resized'): EventCallback =>
      (layout, oldItem, newItem) => {
        const next = withRects(gridStore.getSnapshot().panels, layout)
        gridStore.setPanels(next)
        gridStore.hold('drag', false)
        const panel = next.find((p) => p.i === newItem?.i)
        if (panel === undefined || oldItem === null || newItem === null) {
          return
        }
        const same = oldItem.x === newItem.x && oldItem.y === newItem.y && oldItem.w === newItem.w
        if (same && oldItem.h === newItem.h) {
          return
        }
        announce(
          verb === 'moved'
            ? `${titleOf(panel)} moved to ${placeText(panel)}`
            : `${titleOf(panel)} is now ${sizeText(panel)}`,
        )
      },
    [titleOf],
  )

  const onDragStop = useMemo(() => commit('moved'), [commit])
  const onDragStart = useCallback(() => {
    gridStore.hold('drag', true)
  }, [])
  const onResizeStop = useMemo(() => commit('resized'), [commit])

  const onDrop = useCallback(
    (layout: Layout, item: LayoutItem | undefined, event: Event) => {
      const agent = event instanceof DragEvent ? (event.dataTransfer?.getData(seti().agents.DRAG_TYPE) ?? '') : ''
      if (agent === '') {
        return
      }
      const current = gridStore.getSnapshot().panels
      const empty = emptyPanelUnder(event.target)
      const own = current.find((panel) => panel.agent === agent)
      let id: string
      if (empty !== undefined && empty !== null) {
        gridStore.assign(empty, agent)
        id = empty
      } else if (item === undefined) {
        return
      } else if (own !== undefined) {
        gridStore.setPanels(
          settle(
            current.map((p) => (p.i === own.i ? { ...p, x: item.x, y: item.y } : p)),
            own.i,
          ),
        )
        id = own.i
      } else {
        const at: Rect = { x: item.x, y: item.y, w: item.w, h: item.h }
        const added = addPanel(withRects(current, layout), agent, m, at)
        gridStore.setPanels(added.panels)
        id = added.id
      }
      gridStore.focus(id)
      showInAddress(agent)
      const panel = gridStore.getSnapshot().panels.find((p) => p.i === id)
      if (panel !== undefined) {
        announce(`${titleOf(panel)} placed at ${placeText(panel)}`)
      }
      requestAnimationFrame(() => {
        focusInto(id)
      })
    },
    [m, titleOf],
  )

  const gridConfig = useMemo(
    () => ({ cols: COLS, rowHeight: m.rowHeight, margin: [GAP, GAP] as const, containerPadding: [GAP, GAP] as const }),
    [m.rowHeight],
  )
  const dragConfig = useMemo(
    () => ({ enabled: !locked && arranging === null, handle: '[data-panel-handle]', cancel: NO_DRAG, threshold: 4 }),
    [locked, arranging],
  )
  const resizeConfig = useMemo(
    () => ({ enabled: !locked && arranging === null, handles: RESIZE_HANDLES }),
    [locked, arranging],
  )
  const dropConfig = useMemo(
    () => ({
      enabled: true,
      defaultItem: { w: Math.max(m.minW, COLS / 3), h: Math.max(m.minH, ROWS / 2) },
      onDragOver: (event: DragEvent) =>
        dragHasAgent(event) && emptyPanelUnder(event.target) === undefined ? {} : false,
    }),
    [m.minW, m.minH],
  )
  const layout = useMemo<Layout>(
    () => shown.map(({ i, x, y, w, h }) => ({ i, x, y, w, h, minW: m.minW, minH: m.minH })),
    [shown, m.minW, m.minH],
  )

  const children = useMemo(
    () =>
      shown.map((panel) => {
        const task = panel.agent === null ? null : (byId.get(panel.agent) ?? null)
        return (
          <div
            key={panel.i}
            className="flex"
            data-grid-item={panel.i}
            data-x={panel.x}
            data-y={panel.y}
            data-w={panel.w}
            data-h={panel.h}
          >
            {panel.terminal === undefined ? (
              <GridCell
                id={panel.i}
                task={task}
                focused={panel.i === focused}
                framed={shown.length > 1}
                live={live.has(panel.i)}
                locked={locked}
                arranging={arranging === panel.i}
                subId={panel.agent !== null && panel.agent === routeId ? subId : null}
                pickFrom={task === null || picking === panel.i ? tasks : null}
                placed={placed}
                onChanged={onChanged}
                onSubtasks={onSubtasks}
                onFocusPanel={onFocusPanel}
                onPick={onPick}
                onPicking={setPicking}
                onRemove={onRemove}
                onArrange={arrange}
                onPickTerminal={onPickTerminal}
              />
            ) : (
              <TerminalCell
                id={panel.i}
                terminal={panel.terminal}
                focused={panel.i === focused}
                framed={shown.length > 1}
                locked={locked}
                arranging={arranging === panel.i}
                onFocusPanel={onFocusPanel}
                onArrange={arrange}
              />
            )}
          </div>
        )
      }),
    [
      shown,
      byId,
      focused,
      live,
      locked,
      arranging,
      routeId,
      subId,
      picking,
      tasks,
      placed,
      onChanged,
      onSubtasks,
      onFocusPanel,
      onPick,
      onRemove,
      arrange,
      onPickTerminal,
    ],
  )

  useEffect(() => {
    arranger.current = arrange
    return () => {
      arranger.current = null
    }
  }, [arrange])

  const gridStyle = useMemo(() => ({ minHeight: room.height }), [room.height])
  const agentTitle = useCallback((taskId: string) => byId.get(taskId)?.title ?? '', [byId])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <GridToolbar />
      <FilesDockHost titleOf={agentTitle}>
        <div
          ref={area}
          className="relative min-h-0 min-w-0 flex-1 snap-y snap-proximity overflow-x-hidden overflow-y-auto"
          data-testid="agent-grid"
          data-grid-area
          data-locked={locked}
        >
          <ScreenSnaps perScreen={perScreen} panels={shown} metrics={m} />
          {measured && (
            <Suspense>
              <GridLayout
                width={room.width}
                layout={layout}
                gridConfig={gridConfig}
                dragConfig={dragConfig}
                resizeConfig={resizeConfig}
                dropConfig={dropConfig}
                onDragStart={onDragStart}
                onDragStop={onDragStop}
                onResizeStart={onDragStart}
                onResizeStop={onResizeStop}
                onDrop={onDrop}
                className={cn('agent-grid', locked && 'agent-grid-locked')}
                style={gridStyle}
              >
                {children}
              </GridLayout>
            </Suspense>
          )}
          {measured && shown.length === 0 && (
            <EmptyGrid
              tasks={tasks}
              onPick={(agent) => {
                onPick(gridStore.open(agent), agent)
              }}
              onTerminal={(existing) => {
                if (existing === undefined) {
                  addTerminalTile()
                } else {
                  terminalToGrid(existing)
                }
              }}
            />
          )}
          <p id={ANNOUNCER_ID} role="status" className="sr-only" />
        </div>
      </FilesDockHost>
    </div>
  )
})
