import { DREAM_MODELS, type DreamModel, type DreamNight, type DreamSettings } from '@seti/shared'
import { Moon, Save, Trash2 } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { useLeaveGuard } from '@/hooks/useLeaveGuard'
import { SettingRow, SettingsCard } from './layout'

const TITLE = 'Dreaming'

const MODEL_NAMES: Record<DreamModel, string> = {
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
  agent: "Agent's model",
}

type Form = Pick<DreamSettings, 'window_start' | 'window_end' | 'model' | 'at_once'> & {
  zone: string
  dream_budget_usd: string
  night_budget_usd: string
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

const toForm = (settings: DreamSettings): Form => ({
  window_start: settings.window_start,
  window_end: settings.window_end,
  zone: settings.zone ?? browserZone(),
  model: settings.model,
  at_once: settings.at_once,
  dream_budget_usd: settings.dream_budget_usd.toFixed(2),
  night_budget_usd: settings.night_budget_usd.toFixed(2),
})

const formBody = (form: Form) => ({
  ...form,
  dream_budget_usd: Number(form.dream_budget_usd),
  night_budget_usd: Number(form.night_budget_usd),
})

const ZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return []
  }
})()

/** How last night went, in one line. */
function lastNightLine(night: DreamNight | null): string {
  if (night === null) {
    return 'No night yet'
  }
  if (night.state === 'missed') {
    return `${night.night}: Seti was down for the whole window`
  }
  const dreamt = night.runs.filter((run) => run.state === 'done' || run.state === 'stopped').length
  const skipped =
    night.runs.filter((run) => run.state === 'skipped').length + Object.values(night.skipped).reduce((a, b) => a + b, 0)
  return `${night.night}: ${String(dreamt)} dreamt, ${String(skipped)} skipped, $${night.cost_usd.toFixed(2)}`
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <SettingRow label={label} stack>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </SettingRow>
  )
}

function DreamingForm({ initial, night }: { initial: DreamSettings; night: DreamNight | null }) {
  const zoneList = useId()
  const [saved, setSaved] = useState(initial)
  const [form, setForm] = useState(() => toForm(initial))
  const [busy, setBusy] = useState(false)
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(saved))
  useLeaveGuard(dirty)
  const set = (patch: Partial<Form>) => {
    setForm((current) => ({ ...current, ...patch }))
  }

  const put = async (body: object) => {
    setBusy(true)
    try {
      const next = await apiPut<DreamSettings>('/dreams/settings', body)
      setSaved(next)
      setForm(toForm(next))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard
      title={TITLE}
      actions={
        <Button size="sm" onClick={() => void put(formBody(form))} disabled={!dirty || busy}>
          <Save />
          Save
        </Button>
      }
    >
      <SettingRow
        label="Nightly"
        stack
        description="Lets agents active since their last dream tidy their memory at night, in a sandbox, one at a time."
      >
        <ToggleButton
          pressed={saved.enabled}
          disabled={busy || dirty}
          onPressedChange={(enabled) => void put(enabled ? { enabled, zone: form.zone } : { enabled })}
          icon={Moon}
          label="Dreaming"
          hint={saved.enabled ? 'Turn nightly dreams off' : 'Turn nightly dreams on in the window below'}
        />
      </SettingRow>
      <SettingRow
        label="Clean-ups"
        stack
        description="Lets dreams propose a leftover to remove; you allow each one, and it waits 14 days in the trash."
      >
        <ToggleButton
          pressed={saved.cleanups}
          disabled={busy || dirty}
          onPressedChange={(cleanups) => void put({ cleanups })}
          icon={Trash2}
          label="Propose"
          hint={saved.cleanups ? 'Dreams only report; they propose nothing' : 'Let dreams propose clean-ups for you'}
        />
      </SettingRow>
      <Field label="Window">
        <Input
          aria-label="Window start"
          type="time"
          value={form.window_start}
          onChange={(e) => {
            set({ window_start: e.target.value })
          }}
          className="w-28"
        />
        <span className="text-muted-foreground">to</span>
        <Input
          aria-label="Window end"
          type="time"
          value={form.window_end}
          onChange={(e) => {
            set({ window_end: e.target.value })
          }}
          className="w-28"
        />
      </Field>
      <Field label="Zone">
        <Input
          aria-label="Zone"
          list={zoneList}
          value={form.zone}
          onChange={(e) => {
            set({ zone: e.target.value })
          }}
          className="w-56"
        />
        <datalist id={zoneList}>
          {ZONES.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </Field>
      <Field label="Model">
        <NativeSelect
          aria-label="Model"
          value={form.model}
          onChange={(e) => {
            set({ model: e.target.value as DreamModel })
          }}
        >
          {DREAM_MODELS.map((model) => (
            <NativeSelectOption key={model} value={model}>
              {MODEL_NAMES[model]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Budget">
        <Input
          aria-label="Per dream"
          type="number"
          inputMode="decimal"
          step="0.1"
          value={form.dream_budget_usd}
          onChange={(e) => {
            set({ dream_budget_usd: e.target.value })
          }}
          className="w-20"
        />
        <span className="text-muted-foreground">a dream,</span>
        <Input
          aria-label="Per night"
          type="number"
          inputMode="decimal"
          step="0.5"
          value={form.night_budget_usd}
          onChange={(e) => {
            set({ night_budget_usd: e.target.value })
          }}
          className="w-20"
        />
        <span className="text-muted-foreground">a night, in dollars</span>
      </Field>
      <Field label="At once">
        <NativeSelect
          aria-label="At once"
          value={String(form.at_once)}
          onChange={(e) => {
            set({ at_once: Number(e.target.value) })
          }}
        >
          {[1, 2, 3].map((count) => (
            <NativeSelectOption key={count} value={String(count)}>
              {count}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <SettingRow label="Last night" description={lastNightLine(night)}>
        {null}
      </SettingRow>
    </SettingsCard>
  )
}

/** Nightly Dreaming: off until the user turns it on, its window, zone, model and caps. */
export function DreamingCard() {
  const [state, setState] = useState<{ settings: DreamSettings; night: DreamNight | null } | null>(null)
  useEffect(() => {
    Promise.all([apiGet<DreamSettings>('/dreams/settings'), apiGet<DreamNight | null>('/dreams')]).then(
      ([settings, night]) => {
        setState({ settings, night })
      },
      (e: unknown) => toast.error(errorText(e)),
    )
  }, [])
  if (state === null) {
    return (
      <SettingsCard title={TITLE}>
        <p className="p-3 text-muted-foreground">Loading...</p>
      </SettingsCard>
    )
  }
  return <DreamingForm initial={state.settings} night={state.night} />
}
