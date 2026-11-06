import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { MonitorUp, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefCallback } from 'react'
import { useTheme } from '@/components/theme/theme-context'
import { Button } from '@/components/ui/button'
import { useCoarsePointer } from '@/hooks/useMedia'
import { SelectionBar } from './SelectionBar'
import { TerminalInputs } from './TerminalLine'
import { TerminalSearch } from './TerminalSearch'
import { clipboardKeys } from './terminal-clipboard'
import { FIND_EVENT, findKeys } from './terminal-find'
import { fontKeys, terminalFont } from './terminal-font'
import { isOneChar, newlineKeys, withModifiers } from './terminal-keys'
import { copyFromPrograms } from './terminal-osc52'
import { isTerminalShortcut, keepKeys } from './terminal-shortcut'
import { terminalTheme } from './terminal-theme'
import { pinchToZoom } from './touch-pinch'
import { scrollByTouch } from './touch-scroll'
import { selectByTouch } from './touch-select'
import { retire, useTerminalSocket, type Connection, type ShellTarget, type ShellWhere } from './useTerminalSocket'
import { useLineFocus, useModifiers } from './useTouchInput'

const SCROLLBACK_LINES = 5000

const openLink = (_event: MouseEvent, uri: string) => {
  window.open(uri, '_blank', 'noopener,noreferrer')
}

/** Fits xterm to its host, keeping the bottom in view, or the top line when scrolled back. */
function fitKeepingScroll(term: Terminal, fit: FitAddon): void {
  const { viewportY, baseY } = term.buffer.active
  fit.fit()
  if (viewportY >= baseY) {
    term.scrollToBottom()
  } else {
    term.scrollToLine(viewportY)
  }
}

/** Each terminal's search, loaded as it opens. */
const searches = new WeakMap<Terminal, SearchAddon>()

/** Opens xterm where the returned ref lands, fitted as it resizes and in Seti's theme. */
function useXterm(themeKey: string): { ref: RefCallback<HTMLDivElement>; term: Terminal | null } {
  const [term, setTerm] = useState<Terminal | null>(null)
  const opened = useRef<{ term: Terminal; host: HTMLElement } | null>(null)
  const ref = useCallback((host: HTMLDivElement | null) => {
    if (host === null) {
      return undefined
    }
    const family = getComputedStyle(host).fontFamily
    const fontSize = terminalFont.get()
    // The search addon highlights matches through xterm's decorations, still a proposed API.
    const created = new Terminal({
      fontFamily: family,
      fontSize,
      cursorBlink: true,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    created.loadAddon(fit)
    created.loadAddon(new WebLinksAddon(openLink))
    const search = new SearchAddon()
    created.loadAddon(search)
    searches.set(created, search)
    created.attachCustomKeyEventHandler(
      (event) =>
        !isTerminalShortcut(event) &&
        findKeys(created, event) &&
        fontKeys(event) &&
        clipboardKeys(created, event) &&
        newlineKeys(created, event),
    )
    copyFromPrograms(created)
    created.open(host)
    const untouch = scrollByTouch(created, host)
    const unpinch = pinchToZoom(host)
    created.options.theme = terminalTheme(host)
    let live = true
    // A hidden view leaves no room, and fitting to none would shrink the shell to one row.
    const refit = () => {
      if (live && host.clientWidth > 0 && host.clientHeight > 0) {
        fitKeepingScroll(created, fit)
      }
    }
    refit()
    void document.fonts.ready.then(() => {
      created.options.fontFamily = family
      refit()
    })
    const observer = new ResizeObserver(refit)
    observer.observe(host)
    const unfont = terminalFont.subscribe(() => {
      created.options.fontSize = terminalFont.get()
      refit()
    })
    host.addEventListener('keydown', keepKeys)
    opened.current = { term: created, host }
    setTerm(created)
    return () => {
      live = false
      untouch()
      unpinch()
      unfont()
      host.removeEventListener('keydown', keepKeys)
      observer.disconnect()
      retire(created)
      opened.current = null
      setTerm(null)
    }
  }, [])
  useEffect(() => {
    const current = opened.current
    if (current !== null && themeKey !== '') {
      current.term.options.theme = terminalTheme(current.host)
    }
  }, [themeKey])
  return { ref, term }
}

function Overlay({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/85 p-4 text-center">
      {children}
    </div>
  )
}

function ConnectionNote({ connection, onRestart }: { connection: Connection; onRestart: (fresh: boolean) => void }) {
  if (connection.state === 'open') {
    return null
  }
  if (connection.state === 'connecting') {
    return (
      <p role="status" className="absolute top-2 right-3 z-10 text-2xs text-muted-foreground">
        Connecting...
      </p>
    )
  }
  const handedOff = connection.reason === 'replaced' || connection.reason === 'lost' || connection.reason === 'flood'
  const agentGone = connection.reason === 'archived' || connection.reason === 'deleted'
  return (
    <Overlay>
      <p role="status" className="text-sm">
        {connection.detail}
      </p>
      {!agentGone && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onRestart(!handedOff)
          }}
        >
          {handedOff ? <MonitorUp /> : <RotateCcw />}
          {handedOff ? 'Show here' : 'Restart'}
        </Button>
      )}
    </Overlay>
  )
}

export interface TerminalSessionProps {
  tab: ShellTarget
  /** The terminal shows: it takes focus on a desktop and shows the soft keys on a phone. */
  active: boolean
  /** Shows the row of keys a phone keyboard lacks. */
  softKeys: boolean
  /** Takes focus while active; a layout panel takes it only when it opens focused. */
  takeFocus?: boolean
  /** Typing lands here when keyboard focus lands in the view around it, as in a layout panel. */
  primary?: boolean
  /** Hears where the shell runs once the server started or reattached it. */
  onReady?: (where: ShellWhere) => void
  /** Opens find each time it goes up, as the terminal bar's find button asks. */
  findRequest?: number
}

/** One terminal's shell: xterm connected to it, reattached as long as the server keeps it. */
export function TerminalSession({
  tab,
  active,
  softKeys,
  takeFocus = true,
  primary = false,
  onReady,
  findRequest = 0,
}: TerminalSessionProps) {
  const { scheme, themeId, flavour, accent } = useTheme()
  const { ref, term } = useXterm([scheme, themeId, flavour, accent].join('/'))
  const modifiers = useModifiers()
  const take = modifiers.take
  const transform = useRef((data: string) => (isOneChar(data) ? withModifiers(data, take()) : data))
  const ready = useRef(onReady)
  useEffect(() => {
    ready.current = onReady
  })
  const hooks = useMemo(() => ({ transform, ready }), [])
  const { connection, send, restart } = useTerminalSocket(tab, term, active, hooks)
  const lined = useCoarsePointer() && active
  const { line, focusInput } = useLineFocus(term, lined)

  const [picked, setPicked] = useState<string | null>(null)
  useEffect(() => {
    const host = term?.element?.parentElement
    if (term === null || host === null || host === undefined) {
      return undefined
    }
    const unselect = selectByTouch(term, host, setPicked)
    const cleared = term.onSelectionChange(() => {
      if (!term.hasSelection()) {
        setPicked(null)
      }
    })
    return () => {
      unselect()
      cleared.dispose()
    }
  }, [term])

  const [finding, setFinding] = useState(false)
  const [findsSeen, setFindsSeen] = useState(findRequest)
  if (findRequest !== findsSeen) {
    setFindsSeen(findRequest)
    setFinding(true)
  }
  useEffect(() => {
    const element = term?.element
    if (element === undefined) {
      return undefined
    }
    const open = () => {
      setFinding(true)
    }
    element.addEventListener(FIND_EVENT, open)
    return () => {
      element.removeEventListener(FIND_EVENT, open)
    }
  }, [term])
  const search = term === null ? undefined : searches.get(term)

  useEffect(() => {
    if (active && takeFocus && !softKeys) {
      focusInput()
    }
  }, [active, takeFocus, softKeys, focusInput])

  useEffect(() => {
    if (primary && !lined) {
      term?.textarea?.setAttribute('data-primary-input', 'true')
    }
    return () => {
      term?.textarea?.removeAttribute('data-primary-input')
    }
  }, [primary, lined, term])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 py-1 pl-2">
          <div ref={ref} className="size-full font-mono" />
        </div>
        {term !== null && picked !== null && (
          <SelectionBar
            term={term}
            text={picked}
            onDone={() => {
              setPicked(null)
            }}
          />
        )}
        {term !== null && search !== undefined && finding && (
          <TerminalSearch
            term={term}
            search={search}
            onClose={() => {
              setFinding(false)
            }}
          />
        )}
        <ConnectionNote connection={connection} onRestart={restart} />
      </div>
      {term !== null && (
        <TerminalInputs
          ref={line}
          term={term}
          send={send}
          modifiers={modifiers}
          primary={primary}
          lined={lined}
          keys={softKeys && active}
          focusInput={focusInput}
        />
      )}
    </div>
  )
}
