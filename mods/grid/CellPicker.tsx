import { listedStatus, type ModAgentRow as AgentRow, type TaskListEntry, type TerminalRef } from '@seti/mod-api'
import { Terminal, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Command, CommandEmpty, CommandInput, CommandItem, CommandList, StatusLight } from './parts'
import { seti } from './seti'

/** Rows the picker lists before the filter narrows them. */
const SHOWN = 8

interface CellPickerProps {
  tasks: readonly TaskListEntry[]
  /** Agents already in a cell, listed after the others. */
  placed: ReadonlySet<string>
  onPick: (id: string) => void
  /** Present when the picker covers an agent, to keep it instead. */
  onCancel?: () => void
  /** Takes focus as it opens, as when the user asked to swap the cell's agent. */
  focusOnMount?: boolean
  /** Present where a terminal may go instead of an agent: one outside the grid, or a new one. */
  onTerminal?: (existing?: TerminalRef) => void
}

const TERMINAL_WORDS = 'new terminal shell console'

/** The query asks for nothing yet, or for a terminal. */
const wantsTerminal = (query: string) => TERMINAL_WORDS.includes(query.trim().toLowerCase())

/** Terminals outside the grid the query asks for, by a terminal word or by name. */
function terminalsFor(terminals: readonly TerminalRef[], query: string): readonly TerminalRef[] {
  const wanted = query.trim().toLowerCase()
  return wantsTerminal(query) ? terminals : terminals.filter((t) => t.name.toLowerCase().includes(wanted))
}

/** Finds an agent by title, repo or status to put in a cell. */
export function CellPicker({ tasks, placed, onPick, onCancel, focusOnMount = false, onTerminal }: CellPickerProps) {
  const [query, setQuery] = useState('')
  const terminals = seti().terminals.useOwn()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusOnMount) {
      input.current?.focus()
    }
  }, [focusOnMount])
  const rows = useMemo(() => {
    const all = tasks.map((task): AgentRow => ({
      task,
      running: task.subtask_counts.running,
      status: listedStatus(task),
    }))
    const found = seti().agents.filter(all, query)
    return [...found.filter((row) => !placed.has(row.task.id)), ...found.filter((row) => placed.has(row.task.id))]
  }, [tasks, placed, query])
  return (
    <Command
      shouldFilter={false}
      loop
      label="Pick an agent"
      className="h-auto min-h-0 w-full max-w-80 shrink border border-border bg-background"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onCancel !== undefined) {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <div className="relative">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Pick an agent"
          aria-label="Pick an agent"
          ref={input}
          className="pr-8"
        />
        {onCancel !== undefined && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Keep this agent"
            className="absolute top-1/2 right-2 -translate-y-1/2"
            onClick={onCancel}
          >
            <X />
          </Button>
        )}
      </div>
      <CommandList className="max-h-64 min-h-0 flex-1">
        <CommandEmpty>{tasks.length === 0 ? 'No agents yet.' : 'No agent matches.'}</CommandEmpty>
        {rows.slice(0, query.trim() === '' ? SHOWN : rows.length).map(({ task, status, running }) => (
          <CommandItem
            key={task.id}
            value={task.id}
            {...seti().agents.colorAttr(task.color)}
            className="agent-stripe"
            onSelect={() => {
              onPick(task.id)
            }}
          >
            <span className="min-w-0 flex-1 truncate">{task.title}</span>
            <span className="max-w-[40%] shrink-0 truncate text-2xs text-muted-foreground">
              {placed.has(task.id) ? 'in grid' : seti().agents.placeLabel(task)}
            </span>
            <StatusLight status={status} place="grid" subagents={running} agent={task} />
          </CommandItem>
        ))}
        {onTerminal !== undefined &&
          terminalsFor(terminals, query).map((terminal) => (
            <CommandItem
              key={terminal.id}
              value={`terminal-${terminal.id}`}
              onSelect={() => {
                onTerminal(terminal)
              }}
            >
              <Terminal />
              <span className="min-w-0 flex-1 truncate">{terminal.name}</span>
              <span className="shrink-0 text-2xs text-muted-foreground">terminal</span>
            </CommandItem>
          ))}
        {onTerminal !== undefined && wantsTerminal(query) && (
          <CommandItem
            value="new-terminal"
            onSelect={() => {
              onTerminal()
            }}
          >
            <Terminal />
            <span className="min-w-0 flex-1 truncate">New terminal</span>
          </CommandItem>
        )}
      </CommandList>
    </Command>
  )
}

/** The grid with no panels: a quiet picker, and the whole grid takes agents dragged from the list. */
export function EmptyGrid({
  tasks,
  onPick,
  onTerminal,
}: {
  tasks: readonly TaskListEntry[]
  onPick: (agent: string) => void
  onTerminal: (existing?: TerminalRef) => void
}) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-6">
      <div className="pointer-events-auto flex w-full max-w-80 flex-col items-center gap-2">
        <p className="text-xs text-muted-foreground">Drag agents here or pick one</p>
        <CellPicker tasks={tasks} placed={new Set()} onPick={onPick} onTerminal={onTerminal} />
      </div>
    </div>
  )
}
