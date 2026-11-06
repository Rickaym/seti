import {
  BYPASS_HOURS,
  bypassOn,
  DEFAULT_BYPASS_HOURS,
  type BypassHours,
  type BypassState,
  type Task,
} from '@seti/shared'
import { FastForward } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiPut, errorText } from '@/api'
import { InfoTip } from '@/components/InfoTip'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'

const MAX_TIMER_MS = 2 ** 31 - 1

const BYPASS_DETAIL =
  "Runs every tool without asking for the hours you pick, then turns off by itself. Ask rules stop asking; deny rules, Seti's guards and the sandbox still apply."

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Whether Bypass is on, rendering again the moment it runs out. */
function useBypassOn(until: string | null): boolean {
  const [, setTick] = useState(0)
  useEffect(() => {
    const left = until === null ? 0 : Date.parse(until) - Date.now()
    if (left <= 0) {
      return undefined
    }
    const timer = setTimeout(
      () => {
        setTick((n) => n + 1)
      },
      Math.min(left + 250, MAX_TIMER_MS),
    )
    return () => {
      clearTimeout(timer)
    }
  }, [until])
  return bypassOn(until)
}

/** The agent's Bypass switch with how long it lasts, and until when while it is on. */
export function BypassToggle({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const on = useBypassOn(task.bypass_until)
  const [hours, setHours] = useState<BypassHours>(DEFAULT_BYPASS_HOURS)
  const [busy, setBusy] = useState(false)
  const save = async (next: BypassHours | null) => {
    setBusy(true)
    try {
      const state = await apiPut<BypassState>(`/tasks/${task.id}/permissions/bypass`, { hours: next })
      if (state.applied === 'next_turn') {
        toast.success('Applies from the next turn')
      }
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-0.5" data-testid="bypass">
      <div className="flex flex-wrap items-center gap-2">
        <Switch
          aria-label="Bypass"
          checked={on}
          disabled={busy}
          onCheckedChange={(checked) => void save(checked ? hours : null)}
        />
        {on && task.bypass_until !== null ? (
          <span className="text-muted-foreground" title={new Date(task.bypass_until).toLocaleString()}>
            until {clock(task.bypass_until)}
          </span>
        ) : (
          <NativeSelect
            aria-label="Bypass duration"
            size="sm"
            value={String(hours)}
            onChange={(e) => {
              setHours(BYPASS_HOURS.find((h) => String(h) === e.target.value) ?? DEFAULT_BYPASS_HOURS)
            }}
          >
            {BYPASS_HOURS.map((h) => (
              <NativeSelectOption key={h} value={String(h)}>
                {h} h
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <InfoTip label="About Bypass" text={BYPASS_DETAIL} />
      </div>
      <p className="text-muted-foreground">Runs any tool without asking.</p>
    </div>
  )
}

/** A small mark in the agent's header while its Bypass lasts; only its icon on narrow phones. */
export function BypassBadge({ until }: { until: string | null }) {
  const on = useBypassOn(until)
  if (!on || until === null) {
    return null
  }
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 border border-border px-1.5 py-px text-2xs font-semibold text-muted-foreground uppercase"
      title={`Bypass until ${clock(until)}: tools run without asking`}
    >
      <FastForward className="size-3" aria-hidden />
      <span className="@max-[24rem]/agent:sr-only">Bypass</span>
    </span>
  )
}
