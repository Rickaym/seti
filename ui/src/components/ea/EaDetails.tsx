import { Settings, TriangleAlert, X } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { navigate } from '@/lib/route'
import { cn } from '@/lib/utils'
import { CallControls } from './CallControls'
import { MeterBars } from './MeterBars'
import { asleep, callActive, type CallState } from './call-state'
import { CALL_SHORTCUT, LIGHT, listeningLocally, LOCAL_HINT, meterTrack, statusOf } from './call-status'
import type { SetupNeed } from './useEaHealth'

interface EaDetailsProps {
  id: string
  call: CallState
  need: SetupNeed | null
  /** Touch screens get large call buttons and no shortcut hints. */
  touch: boolean
  /** Shows the details as a bottom sheet, `panel`, rather than a popover above the status bar. */
  sheet: boolean
  panel: RefObject<HTMLDivElement | null>
  onClose: () => void
}

const POPOVER =
  'absolute bottom-full left-0 z-50 mb-px flex w-80 max-w-[calc(100vw-1rem)] flex-col border border-border bg-popover text-xs text-popover-foreground shadow-md motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1'

/** Touch screens skip the hint: a sheet focuses this button first, which would pop it open. */
function SettingsButton({ touch, onClose }: { touch: boolean; onClose: () => void }) {
  const button = (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="EA settings"
      onClick={() => {
        navigate('settings', 'ea')
        onClose()
      }}
    >
      <Settings />
    </Button>
  )
  return touch ? button : <Hint text="Wake word, audio devices, model and relay">{button}</Hint>
}

interface HeaderProps {
  call: CallState
  setup: boolean
  touch: boolean
  onClose: () => void
  closable: boolean
}

function DetailsHeader({ call, setup, touch, onClose, closable }: HeaderProps) {
  const status = statusOf(call)
  const active = callActive(call.phase)
  return (
    <header className="flex items-center gap-2 px-3 py-2">
      <span className={cn('size-2 shrink-0', LIGHT[status.light])} />
      <span className="font-semibold tracking-wider uppercase" data-testid="ea-status">
        {status.label}
      </span>
      <span className="ml-auto text-muted-foreground">
        {!touch && (active || !setup) && (
          <>
            <kbd className="font-mono">{CALL_SHORTCUT.label}</kbd> {active ? 'hangs up' : 'calls'}
          </>
        )}
      </span>
      <SettingsButton touch={touch} onClose={onClose} />
      {closable && (
        <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      )}
    </header>
  )
}

/** Why the EA cannot take a call yet; the settings page says how to fix it. */
function SetupNotice({ need, onClose }: { need: SetupNeed; onClose: () => void }) {
  return (
    <p className="mx-3 mb-3 flex items-start gap-1.5 border border-warning/40 bg-warning/10 px-2.5 py-2" role="status">
      <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning-text" aria-hidden="true" />
      <span className="min-w-0">
        {need.kind === 'down' ? 'The EA is not running.' : 'The EA needs a few keys.'}{' '}
        <Button
          variant="link"
          size="xs"
          className="h-auto px-0"
          onClick={() => {
            navigate('settings', 'ea')
            onClose()
          }}
        >
          Set it up
        </Button>
      </span>
    </p>
  )
}

function Levels({ call }: { call: CallState }) {
  const { signals } = call
  return (
    <div className="flex flex-col items-center gap-1 px-3 pb-3">
      <MeterBars
        track={meterTrack(call)}
        active={call.phase === 'connected' && (signals.botSpeaking || signals.userSpeaking)}
        tone={signals.botSpeaking ? 'bot' : 'user'}
        count={31}
        className="h-8"
      />
      {asleep(call) && call.wake !== null && (
        <span className="text-muted-foreground">Say &quot;{call.wake.phrase}&quot; to wake it</span>
      )}
      {listeningLocally(call) && (
        <span className="text-muted-foreground" data-testid="ea-local-hint">
          {LOCAL_HINT}
        </span>
      )}
    </div>
  )
}

/** The details as a bottom sheet, for screens too narrow for the popover. */
function DetailsSheet({
  panel,
  onClose,
  children,
}: {
  panel: RefObject<HTMLDivElement | null>
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <SheetContent ref={panel} side="bottom" showCloseButton={false} aria-describedby={undefined} className="gap-0">
        <SheetTitle className="sr-only">EA</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  )
}

/** The call at a glance: its state, the voice level and the call buttons; the rest is in settings. */
export function EaDetails({ id, call, need, touch, sheet, panel, onClose }: EaDetailsProps) {
  const setup = need !== null && call.phase !== 'connected'
  const body = (
    <>
      <DetailsHeader call={call} setup={setup} touch={touch} onClose={onClose} closable={sheet} />
      <Levels call={call} />
      {call.phase === 'error' && call.error !== null && (
        <p className="mx-3 mb-3 border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-destructive">
          {call.error}
        </p>
      )}
      {setup && <SetupNotice need={need} onClose={onClose} />}
      <CallControls call={call} canStart={!setup} touch={touch} />
    </>
  )
  if (!sheet) {
    return (
      <section id={id} aria-label="EA call" className={POPOVER}>
        {body}
      </section>
    )
  }
  return (
    <DetailsSheet panel={panel} onClose={onClose}>
      <section id={id} aria-label="EA call" className="flex flex-col text-xs">
        {body}
      </section>
    </DetailsSheet>
  )
}
