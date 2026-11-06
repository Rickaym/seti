import { ChevronRight, XIcon } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
  CommandShortcut,
  CommandItem,
} from '@/components/ui/command'
import { useTasks } from '@/hooks/useTasks'
import { navigate, type Route } from '@/lib/route'
import { PaletteRow } from './PaletteRow'
import {
  closePalette,
  COMMAND_PREFIX,
  isPaletteShortcut,
  takeReturnFocus,
  togglePalette,
  usePalette,
} from './palette-store'
import { PLACE_GROUPS, type Place } from './places'
import { browse, search, type EntryGroup, type PaletteEntry } from './rank'
import { loadRecent, rememberRecent } from './recent'
import { availableCommands, type CommandContext, type PaletteCommand } from './registry'
import { useRegisteredCommands } from './useCommands'
import { usePlaces } from './usePlaces'

const RESULT_LIMIT = 60
const BROWSE_CAP = 8
const BROWSE_GROUPS = [PLACE_GROUPS.section, PLACE_GROUPS.agent]
const COMMANDS_HINT = 'hint:commands'

const placeEntry = (place: Place): PaletteEntry => ({
  id: place.id,
  group: PLACE_GROUPS[place.kind],
  title: place.title,
  detail: place.detail,
  detailTitle: place.detailTitle,
  keywords: place.keywords,
  icon: place.icon,
  status: place.status,
  color: place.color,
  shortcut: place.shortcut,
  run: () => {
    const { target } = place
    if ('run' in target) {
      target.run()
    } else {
      navigate(target.section, target.id)
    }
  },
})

const commandEntry = (command: PaletteCommand, context: CommandContext): PaletteEntry => ({
  id: `cmd:${command.id}`,
  group: command.group,
  title: command.titleFor?.(context) ?? command.title,
  detail: command.detail,
  keywords: command.titleFor === undefined ? command.keywords : `${command.title} ${command.keywords ?? ''}`,
  icon: command.icon,
  shortcut: command.shortcut,
  run: () => {
    command.run(context)
  },
})

function useCommandContext(route: Route): CommandContext {
  const { tasks } = useTasks()
  const agent = route.section === 'agents' ? (tasks.find((task) => task.id === route.id) ?? null) : null
  return useMemo(() => ({ route, agent }), [route, agent])
}

interface BodyProps {
  route: Route
  initialQuery: string
  onPick: (run: () => void) => void
}

function results(query: string, entries: readonly PaletteEntry[], recent: readonly string[], commandMode: boolean) {
  const term = commandMode ? query.slice(COMMAND_PREFIX.length) : query
  if (term.trim() !== '') {
    return search(term, entries, recent, RESULT_LIMIT)
  }
  return commandMode
    ? browse(entries, recent, { cap: Infinity })
    : browse(entries, recent, { cap: BROWSE_CAP, groups: BROWSE_GROUPS })
}

/** The palette's contents, mounted only while it is open so its lists poll only then. */
function PaletteBody({ route, initialQuery, onPick }: BodyProps) {
  const [query, setQuery] = useState(initialQuery)
  const [selected, setSelected] = useState('')
  const [recent, setRecent] = useState(loadRecent)
  const input = useRef<HTMLInputElement>(null)
  const places = usePlaces()
  const commands = useRegisteredCommands()
  const context = useCommandContext(route)
  const commandMode = query.startsWith(COMMAND_PREFIX)

  const groups: EntryGroup[] = useMemo(() => {
    const entries = commandMode
      ? availableCommands(commands, context).map((command) => commandEntry(command, context))
      : places.map(placeEntry)
    return results(query, entries, recent, commandMode)
  }, [query, commandMode, commands, context, places, recent])

  const ids = groups.flatMap((group) => group.items.map((item) => item.entry.id))
  const showHint = !commandMode && query.trim() === ''
  const first = ids[0] ?? (showHint ? COMMANDS_HINT : '')
  const value = selected === COMMANDS_HINT || ids.includes(selected) ? selected : first

  const pick = (entry: PaletteEntry) => {
    setRecent(rememberRecent(entry.id))
    onPick(entry.run)
  }

  return (
    <Command shouldFilter={false} loop value={value} onValueChange={setSelected} className="min-h-0 flex-1">
      <CommandInput
        ref={input}
        value={query}
        onValueChange={(next) => {
          setQuery(next)
          setSelected('')
        }}
        placeholder={commandMode ? 'Run a command' : 'Search agents, PRs, pages...'}
        className="max-md:pr-8"
      />
      <CommandList className="max-h-[min(28rem,60vh)] max-md:max-h-none max-md:flex-1">
        <CommandEmpty>{commandMode ? 'No matching command.' : 'Nothing matches.'}</CommandEmpty>
        {groups.map((group) => (
          <CommandGroup key={group.heading} heading={group.heading}>
            {group.items.map((item) => (
              <PaletteRow
                key={item.entry.id}
                item={item}
                onPick={() => {
                  pick(item.entry)
                }}
              />
            ))}
          </CommandGroup>
        ))}
        {showHint && (
          <CommandGroup heading="Commands">
            <CommandItem
              value={COMMANDS_HINT}
              onSelect={() => {
                setQuery(COMMAND_PREFIX)
                setSelected('')
                input.current?.focus()
              }}
            >
              <ChevronRight className="text-muted-foreground" />
              <span className="flex-1">Show commands</span>
              <CommandShortcut>type {COMMAND_PREFIX}</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1.5 text-2xs text-muted-foreground max-md:hidden">
        <span>
          <kbd className="font-mono">Enter</kbd> open
        </span>
        <span>
          <kbd className="font-mono">Up/Down</kbd> move
        </span>
        <span>
          <kbd className="font-mono">Esc</kbd> close
        </span>
        <span className="ml-auto">
          {commandMode ? (
            <>
              <kbd className="font-mono">Backspace</kbd> places
            </>
          ) : (
            <>
              <kbd className="font-mono">{COMMAND_PREFIX}</kbd> commands
            </>
          )}
        </span>
      </div>
    </Command>
  )
}

/** Ctrl+K anywhere, even in a field, opens or closes the palette. */
function usePaletteShortcut(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isPaletteShortcut(e)) {
        e.preventDefault()
        if (!e.repeat) {
          togglePalette()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [])
}

const DESKTOP = 'top-[12vh] flex max-h-[min(36rem,76vh)] flex-col sm:max-w-xl'
const PHONE =
  'max-md:inset-0 max-md:top-0 max-md:left-0 max-md:h-[var(--app-height,100dvh)] max-md:max-h-none max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:overflow-hidden max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)] max-md:ring-0'

/** Go to places with Ctrl+K, or run commands after typing `>`, as in VS Code. */
export function CommandPalette({ route }: { route: Route }) {
  const { open, initialQuery } = usePalette()
  const pending = useRef<(() => void) | null>(null)
  usePaletteShortcut()

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closePalette()
        }
      }}
      title="Search Seti"
      description="Go to an agent, pull request or page. Type > for commands."
      className={`${DESKTOP} ${PHONE}`}
      contentProps={{
        onCloseAutoFocus: (e) => {
          // A pick runs after the dialog unmounts, so focus it moves is not taken back.
          e.preventDefault()
          const run = pending.current
          pending.current = null
          const back = takeReturnFocus()
          if (run === null) {
            back?.focus()
          } else {
            run()
          }
        },
      }}
    >
      <ErrorBoundary name="Search" kind="inline" resetKey={open}>
        <PaletteBody
          route={route}
          initialQuery={initialQuery}
          onPick={(run) => {
            pending.current = run
            closePalette()
          }}
        />
      </ErrorBoundary>
      <DialogPrimitive.Close asChild>
        <Button variant="ghost" size="icon-sm" className="absolute top-[env(safe-area-inset-top)] right-1 md:hidden">
          <XIcon />
          <span className="sr-only">Close</span>
        </Button>
      </DialogPrimitive.Close>
    </CommandDialog>
  )
}
