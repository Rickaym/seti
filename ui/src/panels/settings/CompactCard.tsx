import { COMPACT_DEFAULTS, type CompactSettings } from '@seti/shared'
import { RotateCcw, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useLeaveGuard } from '@/hooks/useLeaveGuard'
import { CompactFields } from './CompactFields'
import { parseCompactForm, sameCompactForm, toCompactForm, type CompactForm } from './compact-form'
import { SettingsCard } from './layout'

const TITLE = 'Compaction'
const PATH = '/compact'

function CompactEditor({ initial }: { initial: CompactSettings }) {
  const [saved, setSaved] = useState(initial.rule)
  const [form, setForm] = useState<CompactForm>(() => toCompactForm(initial.rule))
  const [busy, setBusy] = useState(false)
  const parsed = parseCompactForm(form)
  const dirty = !sameCompactForm(form, toCompactForm(saved))
  const atDefaults = sameCompactForm(form, toCompactForm(COMPACT_DEFAULTS))
  useLeaveGuard(dirty)

  const save = async () => {
    if ('error' in parsed) {
      toast.error(parsed.error)
      return
    }
    setBusy(true)
    try {
      const next = await apiPut<CompactSettings>(PATH, parsed.rule)
      setSaved(next.rule)
      setForm(toCompactForm(next.rule))
      toast.success('Compaction saved; agents use it from their next turn')
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
          <Hint text="Back to Claude Code's own: auto compact, at the context window it picks, no instructions">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || atDefaults}
              onClick={() => {
                setForm(toCompactForm(COMPACT_DEFAULTS))
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
      <div className="space-y-2 px-3 py-3">
        <p className="text-muted-foreground">
          How Claude Code summarises an agent&apos;s conversation as its context fills, and what each summary keeps. An
          agent&apos;s settings can give it a rule of its own. Agents start their next turn with a change; instructions
          apply at once.
        </p>
        <CompactFields form={form} invalid={'error' in parsed} onChange={setForm} disabled={busy} />
        {'error' in parsed && dirty && (
          <p role="alert" className="text-destructive">
            {parsed.error}
          </p>
        )}
      </div>
    </SettingsCard>
  )
}

/** The compaction rule every agent runs with unless its own settings give it another. */
export function CompactCard() {
  const [settings, setSettings] = useState<CompactSettings | null>(null)
  useEffect(() => {
    apiGet<CompactSettings>(PATH).then(setSettings, (e: unknown) => toast.error(errorText(e)))
  }, [])
  if (settings === null) {
    return (
      <SettingsCard title={TITLE}>
        <p className="p-3 text-muted-foreground">Loading...</p>
      </SettingsCard>
    )
  }
  return <CompactEditor initial={settings} />
}
