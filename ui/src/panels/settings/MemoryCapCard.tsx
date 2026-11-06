import { capLabel, type MemoryCapSettings } from '@seti/shared'
import { RotateCcw, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useLeaveGuard } from '@/hooks/useLeaveGuard'
import { MemoryCapFields } from './MemoryCapFields'
import { SettingRow, SettingsCard } from './layout'
import { parseMemoryForm, sameMemoryForm, toMemoryForm, type MemoryCapForm } from './memory-cap-form'

const TITLE = 'Memory cap'
const PATH = '/resources/memory'

function MemoryCapEditor({ initial }: { initial: MemoryCapSettings }) {
  const [saved, setSaved] = useState(initial)
  const [form, setForm] = useState<MemoryCapForm>(() => toMemoryForm(initial.cap))
  const [busy, setBusy] = useState(false)
  const parsed = parseMemoryForm(form)
  const dirty = !sameMemoryForm(form, toMemoryForm(saved.cap))
  const atDefaults = sameMemoryForm(form, toMemoryForm(saved.defaults))
  useLeaveGuard(dirty)

  const save = async () => {
    if ('error' in parsed) {
      toast.error(parsed.error)
      return
    }
    setBusy(true)
    try {
      const next = await apiPut<MemoryCapSettings>(PATH, parsed.cap)
      setSaved(next)
      setForm(toMemoryForm(next.cap))
      toast.success('Memory cap saved; running agents have it now')
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
          <Hint text={`Back to the defaults: ${capLabel(saved.defaults)}`}>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || atDefaults}
              onClick={() => {
                setForm(toMemoryForm(saved.defaults))
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
        description={`Each agent, with everything it starts, runs in its own systemd scope. Over the RAM cap the kernel stops the agent's largest process, and the rest of the agent goes on. An agent's settings can give it a cap of its own. Defaults: ${capLabel(saved.defaults)}.`}
      >
        <MemoryCapFields form={form} invalid={'error' in parsed} onChange={setForm} disabled={busy} />
      </SettingRow>
      {!saved.enforced && (
        <SettingRow
          label="Not enforced here"
          description="This host cannot start systemd user scopes with a memory controller, so agents run without a cap."
        >
          {null}
        </SettingRow>
      )}
    </SettingsCard>
  )
}

/** The memory cap every agent runs under unless its own settings give it another. */
export function MemoryCapCard() {
  const [settings, setSettings] = useState<MemoryCapSettings | null>(null)
  useEffect(() => {
    apiGet<MemoryCapSettings>(PATH).then(setSettings, (e: unknown) => toast.error(errorText(e)))
  }, [])
  if (settings === null) {
    return (
      <SettingsCard title={TITLE}>
        <p className="p-3 text-muted-foreground">Loading...</p>
      </SettingsCard>
    )
  }
  return <MemoryCapEditor initial={settings} />
}
