import { cpuCapLabel, type CpuCapSettings } from '@seti/shared'
import { RotateCcw, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useLeaveGuard } from '@/hooks/useLeaveGuard'
import { CpuCapFields } from './CpuCapFields'
import { parseCpuForm, sameCpuForm, toCpuForm, type CpuCapForm } from './cpu-cap-form'
import { SettingRow, SettingsCard } from './layout'

const TITLE = 'CPU cap'
const PATH = '/resources/cpu'

function CpuCapEditor({ initial }: { initial: CpuCapSettings }) {
  const [saved, setSaved] = useState(initial)
  const [form, setForm] = useState<CpuCapForm>(() => toCpuForm(initial.cap))
  const [busy, setBusy] = useState(false)
  const parsed = parseCpuForm(form, saved.max_percent)
  const dirty = !sameCpuForm(form, toCpuForm(saved.cap))
  const atDefaults = sameCpuForm(form, toCpuForm(saved.defaults))
  useLeaveGuard(dirty)

  const save = async () => {
    if ('error' in parsed) {
      toast.error(parsed.error)
      return
    }
    setBusy(true)
    try {
      const next = await apiPut<CpuCapSettings>(PATH, parsed.cap)
      setSaved(next)
      setForm(toCpuForm(next.cap))
      toast.success('CPU cap saved; running agents have it now')
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
        <>
          <Hint text={`Back to the default: ${cpuCapLabel(saved.defaults)}`}>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || atDefaults}
              onClick={() => {
                setForm(toCpuForm(saved.defaults))
              }}
            >
              <RotateCcw />
              Defaults
            </Button>
          </Hint>
          <Button size="sm" onClick={() => void save()} disabled={!dirty || busy}>
            <Save />
            Save
          </Button>
        </>
      }
    >
      <SettingRow
        label="Per agent"
        stack
        description={`Each agent, with its subagents and everything it starts, shares its own systemd scope. Under load an agent gets half the CPU share of Seti and your own sessions, and never more than its cap. An agent's settings can give it a cap of its own. Default: ${cpuCapLabel(saved.defaults)}.`}
      >
        <CpuCapFields
          form={form}
          maxPercent={saved.max_percent}
          invalid={'error' in parsed}
          onChange={setForm}
          disabled={busy}
        />
      </SettingRow>
      {!saved.enforced && (
        <SettingRow
          label="Not enforced here"
          description="This host's systemd user manager has no cpu controller, so agents run without a CPU cap."
        >
          {null}
        </SettingRow>
      )}
    </SettingsCard>
  )
}

/** The CPU cap every agent runs under unless its own settings give it another. */
export function CpuCapCard() {
  const [settings, setSettings] = useState<CpuCapSettings | null>(null)
  useEffect(() => {
    apiGet<CpuCapSettings>(PATH).then(setSettings, (e: unknown) => toast.error(errorText(e)))
  }, [])
  if (settings === null) {
    return (
      <SettingsCard title={TITLE}>
        <p className="p-3 text-muted-foreground">Loading...</p>
      </SettingsCard>
    )
  }
  return <CpuCapEditor initial={settings} />
}
