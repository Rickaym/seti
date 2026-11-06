import type { EaLatency, EaUsageStats } from '@seti/shared'
import { Activity, ArrowDownToLine, DatabaseZap, type LucideIcon, Mic, RefreshCw, Timer } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiGet, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { browserTimezone } from '@/components/schedule/cron'
import { Button } from '@/components/ui/button'
import { SettingsCard } from '@/panels/settings/layout'

type Loaded = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; stats: EaUsageStats }

const seconds = (ms: number | null) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`)

const tokens = (count: number | null) => {
  if (count === null) {
    return '-'
  }
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

const percent = (share: number | null) => (share === null ? '-' : `${String(Math.round(share * 100))}%`)

function Stat({
  icon: Icon,
  label,
  value,
  detail,
  hint,
}: {
  icon: LucideIcon
  label: string
  value: string
  detail: string
  hint: string
}) {
  return (
    <Hint text={hint}>
      <button type="button" aria-label={`${label}: ${value}, ${detail}`} className="min-w-0 p-3 text-left">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </span>
        <span className="mt-0.5 block text-lg font-semibold tabular-nums">{value}</span>
        <span className="block truncate text-muted-foreground tabular-nums">{detail}</span>
      </button>
    </Hint>
  )
}

const speechText = (stt: EaLatency, tts: EaLatency) =>
  `Speech to text ${seconds(stt.p50_ms)}, text to speech ${seconds(tts.p50_ms)}, medians on calls`

function Stats({ stats }: { stats: EaUsageStats }) {
  const days = String(stats.window_days)
  const where = stats.by_channel
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 [&>*]:border-border [&>*:nth-child(-n+2)]:border-b sm:[&>*:nth-child(-n+2)]:border-b-0">
        <Stat
          icon={Timer}
          label="First token"
          value={seconds(stats.ttfb.p50_ms)}
          detail={`p95 ${seconds(stats.ttfb.p95_ms)}`}
          hint={`Time to the model's first token over the last ${days} days: the median, and the 95th percentile below it.`}
        />
        <Stat
          icon={ArrowDownToLine}
          label="Input"
          value={tokens(stats.avg_prompt_tokens)}
          detail={`${tokens(stats.avg_completion_tokens)} out`}
          hint={`Average input tokens per model call over ${days} days, cached ones included, and the average output below.`}
        />
        <Stat
          icon={DatabaseZap}
          label="Cached"
          value={percent(stats.cached_share)}
          detail="of input"
          hint="The share of input tokens the prompt cache served, which costs less and answers sooner."
        />
        <Stat
          icon={Activity}
          label="Calls"
          value={`${String(stats.calls_today)} today`}
          detail={`${String(stats.calls_window)} in ${days} days`}
          hint={`Model calls in the last ${days} days: ${String(where.voice)} on calls, ${String(where.chat)} in chat, ${String(where.inbox)} for inbox reports, with ${String(stats.tool_calls)} tool calls.`}
        />
      </div>
      {(stats.stt.samples > 0 || stats.tts.samples > 0) && (
        <p className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-muted-foreground">
          <Mic className="size-3.5 shrink-0" aria-hidden />
          {speechText(stats.stt, stats.tts)}
        </p>
      )}
    </>
  )
}

/** What the EA's model calls cost and how fast they answered over the last week. */
export function UsageCard() {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [round, setRound] = useState(0)

  useEffect(() => {
    let live = true
    apiGet<EaUsageStats>(`/ea/usage?zone=${encodeURIComponent(browserTimezone())}`).then(
      (stats) => {
        if (live) {
          setLoaded({ status: 'ok', stats })
        }
      },
      (e: unknown) => {
        if (live) {
          setLoaded({ status: 'error', message: errorText(e) })
        }
      },
    )
    return () => {
      live = false
    }
  }, [round])

  const refresh = (
    <Hint text="Read the numbers again">
      <Button
        variant="outline"
        size="xs"
        onClick={() => {
          setRound((n) => n + 1)
        }}
      >
        <RefreshCw />
        Refresh
      </Button>
    </Hint>
  )
  return (
    <SettingsCard title="Cost and speed" actions={refresh}>
      {loaded.status === 'loading' && <p className="px-3 py-2 text-muted-foreground">Loading...</p>}
      {loaded.status === 'error' && <p className="px-3 py-2 text-destructive">{loaded.message}</p>}
      {loaded.status === 'ok' && loaded.stats.calls_window === 0 && (
        <p className="px-3 py-2 text-muted-foreground">No EA model calls in the last week yet.</p>
      )}
      {loaded.status === 'ok' && loaded.stats.calls_window > 0 && <Stats stats={loaded.stats} />}
    </SettingsCard>
  )
}
