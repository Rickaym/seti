import {
  ArrowDown,
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, type PointerEvent } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { SYMBOL_KEYS, type Held, type SoftKey } from './terminal-keys'

const ICONS: Partial<Record<SoftKey, LucideIcon>> = {
  Left: ArrowLeft,
  Up: ArrowUp,
  Down: ArrowDown,
  Right: ArrowRight,
  BackTab: ArrowLeftToLine,
}

const NAMES: Partial<Record<SoftKey, string>> = {
  Esc: 'Escape',
  BackTab: 'Shift+Tab',
  PgUp: 'Page up',
  PgDn: 'Page down',
  '|': 'Pipe',
  '~': 'Tilde',
  '/': 'Slash',
  '-': 'Dash',
  _: 'Underscore',
  ':': 'Colon',
  ';': 'Semicolon',
}

const ARROWS: readonly SoftKey[] = ['Left', 'Up', 'Down', 'Right']
const MORE: readonly SoftKey[] = [...SYMBOL_KEYS, 'Home', 'End', 'PgUp', 'PgDn', 'BackTab']

/** A held arrow repeats after this long, this often, as a hardware key does. */
const REPEAT_DELAY_MS = 400
const REPEAT_EVERY_MS = 60
const TAP_BUZZ_MS = 8

/** A short buzz on phones that have one; iPhones have no vibration API. */
function buzz(): void {
  if ('vibrate' in navigator) {
    navigator.vibrate(TAP_BUZZ_MS)
  }
}

/** Keeps the keyboard up: the press never moves focus off the terminal. */
const keep = (event: PointerEvent) => {
  event.preventDefault()
}

export type Modifier = 'ctrl' | 'alt'

interface TerminalKeysProps {
  held: Held
  onKey: (key: SoftKey) => void
  onModifier: (modifier: Modifier) => void
  onPaste: () => void
}

/** Repeats a held key, and tells a click that ends a repeat from a tap. */
function useRepeat(onKey: (key: SoftKey) => void) {
  const timer = useRef<number | undefined>(undefined)
  const repeated = useRef(false)
  const stop = () => {
    window.clearTimeout(timer.current)
    window.clearInterval(timer.current)
    timer.current = undefined
  }
  useEffect(() => stop, [])
  const start = (key: SoftKey) => {
    stop()
    repeated.current = false
    timer.current = window.setTimeout(() => {
      timer.current = window.setInterval(() => {
        repeated.current = true
        onKey(key)
      }, REPEAT_EVERY_MS)
    }, REPEAT_DELAY_MS)
  }
  const tapped = () => {
    const was = repeated.current
    repeated.current = false
    return !was
  }
  return { start, stop, tapped }
}

/**
 * Keys a phone keyboard lacks, in one row that scrolls sideways past the arrows. A tap turns
 * Ctrl or Alt on for the next key, from this row or the keyboard, and another tap turns it off
 * unused. Held arrows repeat.
 */
export function TerminalKeys({ held, onKey, onModifier, onPaste }: TerminalKeysProps) {
  const repeat = useRepeat(onKey)
  const keyButton = (key: SoftKey) => {
    const Icon = ICONS[key]
    const repeats = ARROWS.includes(key)
    return (
      <Button
        key={key}
        variant="outline"
        size="sm"
        className="h-11 min-w-11 flex-1 shrink-0 snap-start px-2 font-mono text-sm"
        aria-label={NAMES[key] ?? key}
        onPointerDown={(event) => {
          keep(event)
          if (repeats) {
            repeat.start(key)
          }
        }}
        onPointerUp={repeat.stop}
        onPointerCancel={repeat.stop}
        onPointerLeave={repeat.stop}
        onClick={() => {
          if (repeat.tapped()) {
            buzz()
            onKey(key)
          }
        }}
      >
        {Icon === undefined ? key : <Icon />}
      </Button>
    )
  }
  const modifierButton = (modifier: Modifier, label: string, name: string) => {
    const on = held[modifier]
    return (
      <Button
        variant="outline"
        size="sm"
        className={cn(
          'h-11 min-w-11 flex-1 shrink-0 snap-start px-2 font-mono text-sm',
          on && 'border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
        )}
        aria-label={name}
        aria-pressed={on}
        onPointerDown={keep}
        onClick={() => {
          buzz()
          onModifier(modifier)
        }}
      >
        {label}
      </Button>
    )
  }
  return (
    <div
      role="toolbar"
      aria-label="Terminal keys"
      className="flex shrink-0 snap-x gap-1 overflow-x-auto overscroll-x-contain border-t border-border p-1 [scrollbar-width:none]"
    >
      {keyButton('Esc')}
      {keyButton('Tab')}
      {modifierButton('ctrl', 'Ctrl', 'Control')}
      {modifierButton('alt', 'Alt', 'Alt')}
      {ARROWS.map(keyButton)}
      <Button
        variant="outline"
        size="sm"
        className="h-11 min-w-11 flex-1 shrink-0 snap-start px-2"
        aria-label="Paste"
        onPointerDown={keep}
        onClick={() => {
          buzz()
          onPaste()
        }}
      >
        <ClipboardPaste />
      </Button>
      {MORE.map(keyButton)}
    </div>
  )
}
