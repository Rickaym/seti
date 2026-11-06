import { Headset, Mic, MicOff, Phone, PhoneOff } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import { toast } from 'sonner'
import { useCommands } from '@/components/palette/useCommands'
import { Button } from '@/components/ui/button'
import { useCoarsePointer, useNarrow } from '@/hooks/useMedia'
import { navigate } from '@/lib/route'
import { cn } from '@/lib/utils'
import { AutoJoinPrompt } from './AutoJoinPrompt'
import { EaDetails } from './EaDetails'
import { MeterBars } from './MeterBars'
import { useAutoJoinStatus, useEaCall, useEaCallStore } from './call-context'
import { asleep, callActive, latestLine, type CallState } from './call-state'
import {
  barStatus,
  CALL_SHORTCUT,
  idleLook,
  isCallShortcut,
  LIGHT,
  listeningLocally,
  LOCAL_HINT,
  meterTrack,
  statusOf,
  type IdleLook,
} from './call-status'
import { useDisclosure } from './useDisclosure'
import { setupNeed, useEaHealth } from './useEaHealth'
import { useEaUnread } from './useEaInbox'
import { useJoinOnOpen } from './useJoinOnOpen'

const SPEAKER = { user: 'You', bot: 'EA' } as const

function wakeLook(call: CallState): 'asleep' | 'awake' | undefined {
  if (call.wake?.enabled !== true) {
    return undefined
  }
  return asleep(call) ? 'asleep' : 'awake'
}

/** Says why each attempt failed, on any page; a call Seti joined itself retries quietly. */
function useFailureToast({ failure, error }: CallState) {
  const seen = useRef(failure)
  useEffect(() => {
    if (failure === null || failure === seen.current || failure.auto) {
      return
    }
    seen.current = failure
    toast.error(failure.dropped ? 'The EA call ended' : 'The EA call could not start', {
      description: error ?? undefined,
    })
  }, [failure, error])
}

function useCallShortcut(onPress: () => void) {
  const handler = useRef(onPress)
  useEffect(() => {
    handler.current = onPress
  })
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isCallShortcut(e) && !e.defaultPrevented) {
        e.preventDefault()
        if (!e.repeat) {
          handler.current()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}

const IDLE: Record<IdleLook, { label: string; tone: string }> = {
  ready: { label: 'Start an EA call', tone: 'text-foreground/80' },
  failed: { label: 'Start an EA call', tone: 'text-destructive' },
  setup: { label: 'EA needs setup', tone: 'text-warning-text' },
}

const ITEM = 'flex h-full min-w-0 items-center gap-1.5 px-2 whitespace-nowrap outline-none'
const HOVER = 'cursor-pointer hover:bg-foreground/10 focus-visible:bg-foreground/10'

interface IdleProps {
  look: IdleLook
  open: boolean
  details: string
  /** A press opens the details, which hold the call button, instead of calling at once. */
  opens: boolean
  onPress: () => void
}

function IdleButton({ look, open, details, opens, onPress }: IdleProps) {
  const { label, tone } = IDLE[look]
  const disclosing = opens || look === 'setup'
  return (
    <button
      type="button"
      aria-label={opens ? 'EA' : label}
      aria-keyshortcuts={disclosing ? undefined : CALL_SHORTCUT.aria}
      aria-expanded={disclosing ? open : undefined}
      aria-controls={disclosing ? details : undefined}
      data-look={look}
      onClick={onPress}
      className={cn(ITEM, HOVER, tone)}
    >
      <Headset className="size-3 shrink-0" aria-hidden="true" />
      <span className="font-semibold tracking-wider">EA</span>
    </button>
  )
}

/** Inbox items the user has not seen, with a press that opens the EA chat where they are. */
function UnreadBadge() {
  const { data } = useEaUnread()
  const unread = data?.unread ?? 0
  const waiting = data?.waiting ?? 0
  if (unread + waiting === 0) {
    return null
  }
  const parts = [
    unread > 0 ? `${String(unread)} new in the EA chat` : '',
    waiting > 0 ? `${String(waiting)} waiting for the EA` : '',
  ]
  const label = parts.filter((part) => part !== '').join(', ')
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid="ea-unread"
      onClick={() => {
        navigate('ea')
      }}
      className={cn(ITEM, HOVER, 'px-1')}
    >
      <span className="min-w-4 bg-primary px-1 text-center text-2xs font-semibold text-primary-foreground tabular-nums">
        {unread + waiting}
      </span>
    </button>
  )
}

interface LiveProps {
  call: CallState
  open: boolean
  details: string
  onToggle: () => void
  onMic: (on: boolean) => void
  onHangUp: () => void
}

function LiveBar({ call, open, details, onToggle, onMic, onHangUp }: LiveProps) {
  const { signals, micOn } = call
  const connected = call.phase === 'connected'
  const line = latestLine(call.captions)
  const micLabel = micOn ? 'Mute microphone' : 'Unmute microphone'
  return (
    <div className="flex h-full min-w-0 items-stretch bg-primary/10" data-testid="ea-bar">
      <button
        type="button"
        aria-label="EA call controls"
        aria-expanded={open}
        aria-controls={details}
        onClick={onToggle}
        className={cn(ITEM, HOVER)}
      >
        <span
          className={cn('size-1.5 shrink-0', LIGHT[statusOf(call).light])}
          data-testid="ea-light"
          data-wake={wakeLook(call)}
        />
        <span className="font-semibold tracking-wider text-primary">EA</span>
        <span
          className="text-foreground/80"
          data-testid="ea-bar-status"
          title={listeningLocally(call) ? LOCAL_HINT : undefined}
        >
          {barStatus(call)}
        </span>
        <MeterBars
          track={meterTrack(call)}
          active={connected && (signals.botSpeaking || signals.userSpeaking)}
          tone={signals.botSpeaking ? 'bot' : 'user'}
          count={7}
          className="h-3 gap-[2px] max-md:hidden"
        />
        {line !== null && (
          <span
            className="max-w-[40ch] min-w-0 truncate text-muted-foreground max-md:hidden"
            data-testid="ea-bar-caption"
          >
            {SPEAKER[line.kind]}: {line.text}
          </span>
        )}
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="h-full"
        disabled={!connected}
        aria-pressed={!micOn}
        aria-label={micLabel}
        title={micLabel}
        onClick={() => {
          onMic(!micOn)
        }}
      >
        {micOn ? <Mic /> : <MicOff />}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="h-full text-destructive hover:bg-destructive/15 hover:text-destructive"
        aria-label="Hang up the EA call"
        aria-keyshortcuts={CALL_SHORTCUT.aria}
        title={`Hang up (${CALL_SHORTCUT.label})`}
        onClick={onHangUp}
      >
        <PhoneOff />
      </Button>
    </div>
  )
}

/** The EA in the status bar: one press starts a call, hovering shows the call controls. */
export function EaItem() {
  const store = useEaCallStore()
  const call = useEaCall()
  const health = useEaHealth().state
  const need = setupNeed(health)
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const touch = useCoarsePointer()
  const narrow = useNarrow()
  const disclosure = useDisclosure(root, { panel, hover: !narrow })
  const details = useId()
  const active = callActive(call.phase)
  useFailureToast(call)

  const start = () => {
    if (need === null) {
      void store.connect()
    } else {
      disclosure.pin()
    }
  }
  const hangUp = () => {
    void store.hangUp()
  }
  useCallShortcut(active ? hangUp : start)
  useCommands([
    {
      id: 'ea.call',
      title: active ? 'End EA call' : 'Start EA call',
      icon: active ? PhoneOff : Phone,
      group: 'General',
      keywords: 'executive assistant voice talk hang up',
      shortcut: CALL_SHORTCUT.label,
      run: active ? hangUp : start,
    },
  ])
  useJoinOnOpen(health.status === 'up' && need === null)
  const joining = useAutoJoinStatus()

  return (
    <div
      ref={root}
      role="group"
      aria-label="EA"
      className="relative flex h-full min-w-0 items-stretch border-r border-border"
      data-testid="ea-item"
      data-join={joining}
      {...disclosure.handlers}
    >
      {active ? (
        <LiveBar
          call={call}
          open={disclosure.open}
          details={details}
          onToggle={disclosure.toggle}
          onMic={store.setMic}
          onHangUp={hangUp}
        />
      ) : (
        <IdleButton
          look={idleLook(call.phase, need !== null, call.failure?.auto === true)}
          open={disclosure.open}
          details={details}
          opens={touch}
          onPress={need === null && !touch ? start : disclosure.toggle}
        />
      )}
      <AutoJoinPrompt />
      <UnreadBadge />
      {disclosure.open && (
        <EaDetails
          id={details}
          call={call}
          need={need}
          touch={touch}
          sheet={narrow}
          panel={panel}
          onClose={disclosure.close}
        />
      )}
    </div>
  )
}
