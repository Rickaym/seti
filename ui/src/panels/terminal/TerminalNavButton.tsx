import { Plus, Terminal } from 'lucide-react'
import { useEffect, useRef, type ComponentProps } from 'react'
import { Hint } from '@/components/Hint'
import { useCommands } from '@/components/palette/useCommands'
import { Button } from '@/components/ui/button'
import { isTerminalShortcut, TERMINAL_SHORTCUT, TERMINAL_SHORTCUT_ARIA } from './terminal-shortcut'
import { useOpenTerminal } from './useOpenTerminal'

/** The way into terminals from the navigation. */
export function TerminalNavButton({
  side,
  className,
}: {
  side?: ComponentProps<typeof Hint>['side']
  className?: string
}) {
  const open = useOpenTerminal()
  return (
    <Hint text={`Terminal (${TERMINAL_SHORTCUT})`} side={side}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Terminal"
        aria-keyshortcuts={TERMINAL_SHORTCUT_ARIA}
        className={className}
        onClick={() => {
          void open()
        }}
      >
        <Terminal />
      </Button>
    </Hint>
  )
}

/** The terminal's row in the phone menu drawer, which shows a terminal alone. */
export function TerminalDrawerItem({ onOpen }: { onOpen: () => void }) {
  const open = useOpenTerminal()
  return (
    <button
      type="button"
      onClick={() => {
        onOpen()
        void open()
      }}
      className="flex min-h-11 w-full items-center gap-3 px-4 text-left text-sm text-foreground/80 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Terminal className="size-[18px] shrink-0" />
      Terminal
    </button>
  )
}

/** Ctrl+` and the palette do what the terminal button does, from anywhere. */
export function TerminalCommands(): null {
  const open = useOpenTerminal()
  const latest = useRef(open)
  useEffect(() => {
    latest.current = open
  })
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isTerminalShortcut(event) && !event.defaultPrevented) {
        event.preventDefault()
        if (!event.repeat) {
          void latest.current()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])
  useCommands([
    {
      id: 'terminal.open',
      title: 'Terminal',
      icon: Terminal,
      group: 'General',
      keywords: 'shell console bash open',
      shortcut: TERMINAL_SHORTCUT,
      run: () => {
        void open()
      },
    },
    {
      id: 'terminal.new',
      title: 'New terminal',
      icon: Plus,
      group: 'General',
      keywords: 'shell console bash tab',
      run: () => {
        void open(true)
      },
    },
  ])
  return null
}
