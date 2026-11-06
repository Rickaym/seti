import type { TerminalRef } from '@seti/shared'
import { Check, ChevronDown, Pencil, Plus, RotateCcw, Search, Terminal as TerminalIcon, X } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { DetailBar, DetailBarActions } from '@/components/DetailBar'
import { Hint } from '@/components/Hint'
import { BackButton } from '@/components/SplitPane'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useNarrow } from '@/hooks/useMedia'
import { PANEL, PANEL_PASSTHROUGH } from '@/lib/panels'
import { navigate } from '@/lib/route'
import { setLayoutActive, useLayouts, type AgentsLayout } from '@/panels/tasks/agents-layouts'
import { TerminalName } from './TerminalName'
import { TerminalView } from './TerminalView'
import { shellStarts, stopShell } from './shells'
import { HOME_PLACE } from './terminal-list'
import {
  closeTerminal,
  openNewTerminal,
  openTerminalAlone,
  recentTerminal,
  refreshTerminalSources,
  renameTerminal,
  useTerminals,
  type KnownTerminal,
} from './terminal-sources'
import { terminalStore } from './terminal-store'
import type { ShellWhere } from './useTerminalSocket'

/** Lists every terminal to switch to, then a new one and a rename for this one. */
function TerminalSwitcher({
  current,
  known,
  onRename,
}: {
  current: TerminalRef
  known: readonly KnownTerminal[]
  onRename: () => void
}) {
  return (
    <DropdownMenu modal={false}>
      <Hint text="Switch terminal">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Switch terminal" className="min-w-0 shrink gap-1 px-1.5">
            <span className="truncate text-sm font-semibold">{current.name}</span>
            <ChevronDown className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="start" className="max-w-[min(24rem,90vw)]">
        {known.map(({ terminal, label }) => (
          <DropdownMenuItem
            key={terminal.id}
            title={terminal.name}
            onSelect={() => {
              openTerminalAlone(terminal.id)
            }}
          >
            {terminal.id === current.id ? <Check /> : <TerminalIcon />}
            <span className="min-w-0 flex-1 truncate">{terminal.name}</span>
            {label !== null && <span className="shrink-0 text-2xs text-muted-foreground">{label}</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            openNewTerminal(HOME_PLACE)
          }}
        >
          <Plus />
          New terminal
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRename}>
          <Pencil />
          Rename
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Moves the terminal into a layout, turning the layout on to show it. */
function AdoptButton({ layout, terminal }: { layout: AgentsLayout; terminal: TerminalRef }) {
  const name = layout.title.toLowerCase()
  const Icon = layout.icon
  return (
    <Hint text={`Move to the ${name}; the shell keeps running`}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Open in ${name}`}
        onClick={() => {
          setLayoutActive(layout, true)
          layout.adoptTerminal?.(terminal)
        }}
      >
        <Icon />
      </Button>
    </Hint>
  )
}

/** After a close, the terminal shown last, or the Agents page when none is left. */
function showNext(): void {
  const next = recentTerminal()
  if (next === null) {
    navigate('agents')
  } else {
    openTerminalAlone(next)
  }
}

function ClosedTerminal() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">This terminal is closed.</p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          openNewTerminal(HOME_PLACE)
        }}
      >
        <Plus />
        New terminal
      </Button>
    </div>
  )
}

/** One terminal as the whole detail view, the way an agent opens alone; phones get soft keys. */
function TerminalAlone({ id }: { id: string }) {
  const narrow = useNarrow()
  const layouts = useLayouts(narrow).filter((layout) => layout.adoptTerminal !== undefined)
  const known = useTerminals()
  const terminal = known.find((entry) => entry.terminal.id === id)?.terminal
  const [editing, setEditing] = useState(false)
  const [run, setRun] = useState(0)
  const [finds, setFinds] = useState(0)
  const [where, setWhere] = useState<ShellWhere | null>(null)
  useEffect(() => {
    terminalStore.touch(id)
  }, [id])
  useEffect(() => {
    void refreshTerminalSources()
  }, [])
  if (terminal === undefined) {
    return <ClosedTerminal />
  }
  const restart = async () => {
    await stopShell(terminal.id)
    shellStarts.allow(terminal.id)
    setRun((n) => n + 1)
  }
  return (
    <section
      aria-label="Terminal"
      {...PANEL}
      {...PANEL_PASSTHROUGH}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <DetailBar className="typing:not-focus-within:hidden">
        <BackButton section="agents" label="agents" />
        <TerminalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        {editing ? (
          <TerminalName
            name={terminal.name}
            label="Terminal name"
            onCommit={(name) => {
              renameTerminal(terminal.id, name)
            }}
            onDone={() => {
              setEditing(false)
            }}
            className="w-44"
          />
        ) : (
          <TerminalSwitcher
            current={terminal}
            known={known}
            onRename={() => {
              setEditing(true)
            }}
          />
        )}
        {where !== null && (
          <span className="min-w-0 truncate text-2xs text-muted-foreground max-md:hidden" title={where.cwd}>
            {where.sandboxed ? 'in the sandbox' : 'on this machine'} <span className="font-mono">{where.cwd}</span>
          </span>
        )}
        <DetailBarActions>
          {layouts.map((layout) => (
            <AdoptButton key={layout.key} layout={layout} terminal={terminal} />
          ))}
          <Hint text="Find in the output (Ctrl+Shift+F)">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Find in terminal output"
              onClick={() => {
                setFinds((n) => n + 1)
              }}
            >
              <Search />
            </Button>
          </Hint>
          <Hint text="Restart with a new shell">
            <Button variant="ghost" size="icon-sm" aria-label="Restart terminal" onClick={() => void restart()}>
              <RotateCcw />
            </Button>
          </Hint>
          <Hint text="Close and end the shell">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close terminal"
              onClick={() => {
                closeTerminal(terminal.id)
                showNext()
              }}
            >
              <X />
            </Button>
          </Hint>
        </DetailBarActions>
      </DetailBar>
      <div className="relative min-h-0 flex-1">
        <TerminalView
          key={run}
          tab={{ id: terminal.id, taskId: terminal.task }}
          active
          softKeys={narrow}
          primary
          onReady={setWhere}
          findRequest={finds}
        />
      </div>
    </section>
  )
}

/** Terminal `id` alone, or the detail the address otherwise names when it names no terminal. */
export function TerminalOr({ id, detail }: { id: string | null; detail: () => ReactElement }): ReactElement {
  return id === null ? detail() : <TerminalAlone key={id} id={id} />
}
