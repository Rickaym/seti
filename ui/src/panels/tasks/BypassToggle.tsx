import {
  BYPASS_HOURS,
  bypassOn,
  DEFAULT_BYPASS_HOURS,
  type AgentCapabilities,
  type BypassHours,
  type Task,
} from '@seti/shared'
import { FastForward } from 'lucide-react'
import { useEffect, useState } from 'react'
import { InfoTip } from '@/components/InfoTip'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { NotOnRuntime } from '@/panels/tasks/NotOnCodex'
import { BYPASS_DETAIL, saveBypass } from '@/panels/tasks/setting-actions'

const MAX_TIMER_MS = 2 ** 31 - 1

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
function BypassToggle({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const on = useBypassOn(task.bypass_until)
  const [hours, setHours] = useState<BypassHours>(DEFAULT_BYPASS_HOURS)
  const [busy, setBusy] = useState(false)
  const save = async (next: BypassHours | null) => {
    setBusy(true)
    await saveBypass(task, next, onChanged)
    setBusy(false)
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
      <p className="text-muted-foreground">Runs tools without asking, except ask rules.</p>
    </div>
  )
}

/** Bypass for the agent, or why its runtime does not offer it. */
export function TaskBypass({
  task,
  caps,
  onChanged,
}: {
  task: Task
  caps: AgentCapabilities | null
  onChanged: () => void
}) {
  if (caps?.bypass === false) {
    return (
      <NotOnRuntime
        label={caps.label}
        reason={`${caps.label} agents ask before every command and edit; Bypass is not offered.`}
      />
    )
  }
  return <BypassToggle task={task} onChanged={onChanged} />
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
      title={`Bypass until ${clock(until)}: tools run without asking, except ask rules`}
    >
      <FastForward className="size-3" aria-hidden />
      <span className="@max-[24rem]/agent:sr-only">Bypass</span>
    </span>
  )
}
