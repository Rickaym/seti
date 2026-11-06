import { Check, LoaderCircle, Wrench, X } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { CallControls } from '@/components/ea/CallControls'
import { MeterBars } from '@/components/ea/MeterBars'
import { useEaHistory, useEaHistoryStore } from '@/components/ea/call-context'
import { asleep, type CallState } from '@/components/ea/call-state'
import { LIGHT, listeningLocally, LOCAL_HINT, meterTrack, statusOf } from '@/components/ea/call-status'
import type { ActionItem, SpeechItem } from '@/components/ea/captions'
import { useNarrow } from '@/hooks/useMedia'
import { cn } from '@/lib/utils'
import { inFlight, settledCount, type FeedItem } from './call-feed'

/** Time for the bot to store a finished line before the conversation is fetched again. */
const LAND_MS = 800

const SPEAKER = { user: 'You', bot: 'EA' } as const

function Speech({ item }: { item: SpeechItem }) {
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-2 py-1" data-kind={item.kind}>
      <span
        className={cn(
          'pt-0.5 text-2xs font-semibold tracking-wider uppercase',
          item.kind === 'bot' ? 'text-primary' : 'text-muted-foreground',
        )}
      >
        {SPEAKER[item.kind]}
      </span>
      <p className={cn('leading-relaxed whitespace-pre-wrap', !item.final && 'text-muted-foreground')}>{item.text}</p>
    </li>
  )
}

function ActionState({ item }: { item: ActionItem }) {
  if (item.running && item.ok === null) {
    return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Running" />
  }
  if (item.ok === true) {
    return <Check className="size-3.5 shrink-0 text-success" aria-label="Done" />
  }
  if (item.ok === false) {
    return <X className="size-3.5 shrink-0 text-destructive" aria-label="Failed" />
  }
  return <span className="size-3.5 shrink-0" />
}

function Action({ item }: { item: ActionItem }) {
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-2 py-0.5" data-kind="action">
      <span />
      <div
        className={cn(
          'flex min-w-0 items-center gap-2 border-l-2 bg-muted/50 px-2 py-1',
          item.ok === false ? 'border-l-destructive' : 'border-l-primary/60',
        )}
      >
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 font-semibold">{item.tool}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.summary ?? undefined}>
          {item.summary ?? (item.running ? 'Working...' : '')}
        </span>
        <ActionState item={item} />
      </div>
    </li>
  )
}

/** What is being said and done right now, following the newest line as it grows. */
function Feed({ items }: { items: readonly FeedItem[] }) {
  const box = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const element = box.current
    if (element !== null) {
      element.scrollTop = element.scrollHeight
    }
  }, [items])
  return (
    <ol ref={box} aria-label="Live" className="max-h-44 overflow-y-auto border-t border-border px-3 py-1.5">
      {items.map((item) =>
        item.kind === 'action' ? <Action key={item.id} item={item} /> : <Speech key={item.id} item={item} />,
      )}
    </ol>
  )
}

/** Lines the call has finished land in the transcript soon after, instead of at the next poll. */
function useLanding(call: CallState) {
  const store = useEaHistoryStore()
  const settled = settledCount(call.captions.items)
  useEffect(() => {
    if (settled === 0) {
      return undefined
    }
    const timer = window.setTimeout(() => void store.refresh(), LAND_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [settled, store])
}

/** The live call on the EA page: its state and level, the call buttons, and what is in flight. */
export function CallCard({ call, touch }: { call: CallState; touch: boolean }) {
  const { entries } = useEaHistory()
  const narrow = useNarrow()
  const feed = useMemo(() => inFlight(call.captions.items, entries), [call.captions.items, entries])
  const status = statusOf(call)
  const { signals } = call
  useLanding(call)
  return (
    <section
      aria-label="Live call"
      className="border border-primary/30 bg-card text-xs text-card-foreground shadow-sm select-text"
    >
      <div className="flex min-h-11 items-center gap-2.5 px-3 py-1.5">
        <span className={cn('size-2 shrink-0', LIGHT[status.light])} aria-hidden="true" />
        <span className="font-semibold tracking-wider uppercase" data-testid="ea-call-status">
          {status.label}
        </span>
        <MeterBars
          track={meterTrack(call)}
          active={call.phase === 'connected' && (signals.botSpeaking || signals.userSpeaking)}
          tone={signals.botSpeaking ? 'bot' : 'user'}
          count={narrow ? 11 : 17}
          className="h-4 gap-[2px]"
        />
        {asleep(call) && call.wake !== null && (
          <span
            className="min-w-0 truncate text-muted-foreground"
            title={listeningLocally(call) ? LOCAL_HINT : undefined}
          >
            Say &quot;{call.wake.phrase}&quot;{listeningLocally(call) && ', listening locally'}
          </span>
        )}
        {!narrow && <CallControls call={call} canStart touch={touch} className="ml-auto p-0" />}
      </div>
      {feed.length > 0 && <Feed items={feed} />}
      {narrow && <CallControls call={call} canStart touch={touch} className="border-t border-border pt-2" />}
    </section>
  )
}
