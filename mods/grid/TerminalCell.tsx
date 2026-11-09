import type { TerminalRef } from '@seti/mod-api'
import { EllipsisVertical, GripVertical, Maximize2, Move, Pencil, RotateCcw, Terminal, X } from 'lucide-react'
import { memo, useState } from 'react'
import { gridStore } from './grid-store'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Hint,
  TerminalName,
  TerminalView,
} from './parts'
import { cn, seti } from './seti'
import { closeTile, removeTile, tileAlone } from './tiles'

/** Where a terminal's shell runs. */
interface Where {
  cwd: string
  sandboxed: boolean
}

interface TerminalCellProps {
  id: string
  terminal: TerminalRef
  focused: boolean
  /** Shows the focus frame; a lone panel needs none. */
  framed: boolean
  locked: boolean
  /** Arrow keys move and resize this panel. */
  arranging: boolean
  onFocusPanel: (id: string) => void
  onArrange: (id: string) => void
}

function whereText(where: Where | null): string | undefined {
  if (where === null) {
    return undefined
  }
  return `${where.sandboxed ? 'In the sandbox' : 'On this machine'}, in ${where.cwd}`
}

interface TileMenuProps {
  id: string
  locked: boolean
  onRename: () => void
  onArrange: () => void
}

function TileMenu({ id, locked, onRename, onArrange }: TileMenuProps) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="More terminal actions">
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onRename}>
          <Pencil />
          Rename
        </DropdownMenuItem>
        {!locked && (
          <DropdownMenuItem onSelect={onArrange}>
            <Move />
            Arrange
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() => {
            tileAlone(id)
          }}
        >
          <Maximize2 />
          Open alone
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            removeTile(id)
          }}
        >
          <X />
          Remove from grid
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A terminal in the grid: a panel like an agent's, holding a shell instead of a chat. */
export const TerminalCell = memo(function TerminalCellView({
  id,
  terminal,
  focused,
  framed,
  locked,
  arranging,
  onFocusPanel,
  onArrange,
}: TerminalCellProps) {
  const [editing, setEditing] = useState(false)
  const [run, setRun] = useState(0)
  const [where, setWhere] = useState<Where | null>(null)
  const [focusOnStart] = useState(focused)
  const restart = async () => {
    await seti().terminals.stop(terminal.id)
    seti().terminals.allowStart(terminal.id)
    setRun((n) => n + 1)
  }
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions --
     A panel takes focus from any press inside it. */
  return (
    <section
      aria-label={`Terminal tile: ${terminal.name}`}
      data-grid-cell=""
      data-grid-panel={id}
      data-grid-focused={focused}
      data-grid-terminal=""
      {...seti().panels.markers.PANEL}
      {...seti().panels.markers.focused(focused)}
      tabIndex={-1}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-border bg-background outline-none',
        'after:pointer-events-none after:absolute after:inset-0 after:z-30 after:border-primary',
        framed && focused && 'after:border-2',
        arranging && 'after:border-2 after:border-dashed',
      )}
      onFocus={() => {
        onFocusPanel(id)
      }}
      onPointerDown={() => {
        onFocusPanel(id)
      }}
    >
      <div
        data-panel-handle=""
        className={cn(
          'agent-rule flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-1',
          !locked && 'cursor-grab',
        )}
      >
        <span aria-hidden className="flex h-6 w-4 shrink-0 items-center justify-center text-muted-foreground/70">
          {!locked && <GripVertical className="size-3.5" />}
        </span>
        <Terminal aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        {editing ? (
          <TerminalName
            name={terminal.name}
            label="Terminal name"
            onCommit={(name) => {
              gridStore.renameTerminal(id, name)
            }}
            onDone={() => {
              setEditing(false)
            }}
            className="mr-auto w-44"
          />
        ) : (
          <h2
            className="min-w-0 flex-1 truncate text-sm font-semibold"
            title={whereText(where)}
            onDoubleClick={() => {
              setEditing(true)
            }}
          >
            {terminal.name}
          </h2>
        )}
        <Hint text="Restart with a new shell">
          <Button variant="ghost" size="icon-xs" aria-label="Restart terminal" onClick={() => void restart()}>
            <RotateCcw />
          </Button>
        </Hint>
        <TileMenu
          id={id}
          locked={locked}
          onRename={() => {
            setEditing(true)
          }}
          onArrange={() => {
            onArrange(id)
          }}
        />
        <Hint text="Close and end the shell">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close terminal"
            onClick={() => {
              closeTile(id)
            }}
          >
            <X />
          </Button>
        </Hint>
      </div>
      <div className="relative min-h-0 flex-1">
        <TerminalView
          key={run}
          tab={{ id: terminal.id, taskId: terminal.task }}
          active
          softKeys={false}
          takeFocus={focusOnStart}
          primary
          onReady={setWhere}
        />
      </div>
      {arranging && (
        <p
          aria-hidden
          className="absolute inset-x-0 bottom-0 z-40 bg-primary px-2 py-1 text-2xs text-primary-foreground"
        >
          Arrows move, Shift+Arrows resize, Enter keeps, Esc cancels
        </p>
      )}
    </section>
  )
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions --
     End of the terminal panel. */
})
