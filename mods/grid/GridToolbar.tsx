import { Eraser, Lock, LockOpen, Rows3, Terminal } from 'lucide-react'
import { clearGrid, lockGrid, setPerScreen, tidyGrid } from './grid-actions'
import { PER_SCREEN, templateAcross, templateRows } from './grid-layout'
import { useGrid } from './grid-store'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Hint,
  ToggleButton,
} from './parts'
import { cn } from './seti'
import { addTerminalTile } from './tiles'

function panelCount(count: number): string {
  if (count === 0) {
    return 'No panels'
  }
  return `${String(count)} ${count === 1 ? 'panel' : 'panels'}`
}

/** A template in miniature: its rows of panels, or one dashed screen for every panel in one. */
function TemplateThumb({ perScreen, className }: { perScreen: number | null; className?: string }) {
  if (perScreen === null) {
    return <span aria-hidden="true" className={cn('rounded-[2px] border border-dashed border-current', className)} />
  }
  return (
    <span aria-hidden="true" className={cn('flex flex-col gap-px', className)}>
      {templateRows(perScreen).map((across, row) => (
        <span key={row} className="flex flex-1 gap-px">
          {Array.from({ length: across }, (_, col) => (
            <span key={col} className="flex-1 rounded-[1px] bg-current opacity-70" />
          ))}
        </span>
      ))}
    </span>
  )
}

const FIT_ALL = 'all'

const templateLabel = (perScreen: number | null) =>
  perScreen === null ? 'All in one screen' : `Up to ${String(perScreen)} per screen`

/** How a template lays a screen out: the most panels in it, and the most across one row. */
const templateHint = (perScreen: number | null) =>
  perScreen === null
    ? 'every panel in one screen'
    : `up to ${String(perScreen)} a screen, up to ${String(templateAcross(perScreen))} a row`

/** Picks the most panels one screen holds; Tidy and new panels follow it, extra panels go below. */
function TemplatePicker() {
  const { perScreen } = useGrid()
  return (
    <DropdownMenu modal={false}>
      <Hint text={`Panels per screen: ${templateHint(perScreen)}`}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label={`Panels per screen: ${templateLabel(perScreen)}`}>
            <TemplateThumb perScreen={perScreen} className="h-3 w-4" />
            {perScreen === null ? 'Fit' : String(perScreen)}
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={perScreen === null ? FIT_ALL : String(perScreen)}
          onValueChange={(value) => {
            setPerScreen(value === FIT_ALL ? null : Number(value))
          }}
        >
          <DropdownMenuRadioItem value={FIT_ALL}>
            <TemplateThumb perScreen={null} className="h-4 w-6" />
            {templateLabel(null)}
          </DropdownMenuRadioItem>
          {PER_SCREEN.map((n) => (
            <DropdownMenuRadioItem key={n} value={String(n)}>
              <TemplateThumb perScreen={n} className="h-4 w-6" />
              {templateLabel(n)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Terminal, Lock, Tidy and Clear along the top of the grid, level with the Agents list header. */
export function GridToolbar() {
  const { locked, panels, perScreen } = useGrid()
  const count = panels.length
  return (
    <div
      role="group"
      aria-label="Grid layout"
      className="flex shrink-0 items-center gap-1.5 border-b border-border bg-background px-3 py-2"
    >
      <p className="mr-auto min-w-0 truncate text-xs text-muted-foreground tabular-nums">{panelCount(count)}</p>
      <Hint text="Add a terminal to the grid, in the home folder">
        <Button variant="outline" size="sm" onClick={addTerminalTile}>
          <Terminal />
          Terminal
        </Button>
      </Hint>
      <ToggleButton
        pressed={locked}
        onPressedChange={lockGrid}
        icon={locked ? <Lock /> : <LockOpen />}
        label="Lock"
        hint={locked ? 'Unlock to drag and resize panels' : 'Keep panels from moving or resizing'}
      />
      <TemplatePicker />
      <Hint
        text={
          perScreen === null
            ? 'Lay the panels out evenly to fit the window'
            : `Lay the panels out ${templateHint(perScreen)}, in even rows, the rest on screens below`
        }
      >
        <Button variant="outline" size="sm" disabled={count === 0} onClick={tidyGrid}>
          <Rows3 />
          Tidy
        </Button>
      </Hint>
      <Hint text="Take every panel out; agents keep running">
        <Button variant="outline" size="sm" disabled={count === 0} onClick={clearGrid}>
          <Eraser />
          Clear
        </Button>
      </Hint>
    </div>
  )
}
