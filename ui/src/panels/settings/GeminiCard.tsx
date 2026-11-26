import { GEMINI_MODELS, geminiModelLabel, type GeminiSettingsInput, type GeminiStatus } from '@seti/shared'
import { Gem, Scale } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, apiPut, errorText } from '@/api'
import { ToggleButton } from '@/components/ToggleButton'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { useInstallPoll } from '@/hooks/useInstallPoll'
import { refreshRuntimes, useRuntimes } from '@/hooks/useRuntimes'
import { InstallRow, KeyRow, StateWord, type RuntimeWords } from './RuntimeParts'
import { SettingRow, SettingsCard } from './layout'

const WORDS: RuntimeWords = { name: 'Gemini', program: 'Gemini CLI', key: 'Gemini API' }

const DEFAULT = ''

interface RowProps {
  status: GeminiStatus
  busy: boolean
  put: (body: GeminiSettingsInput) => Promise<void>
}

function DefaultModelRow({ status, busy, put }: RowProps) {
  return (
    <SettingRow
      label="Default model"
      stack
      description={`The model a new Gemini agent starts with unless it picks its own. Cost is an estimate from Google's prices as of ${status.pricesAsOf}.`}
    >
      <NativeSelect
        aria-label="Default model"
        value={status.settings.default_model ?? DEFAULT}
        disabled={busy}
        onChange={(e) => void put({ default_model: GEMINI_MODELS.find((id) => id === e.target.value) ?? null })}
      >
        <NativeSelectOption value={DEFAULT}>Default model</NativeSelectOption>
        {GEMINI_MODELS.map((id) => (
          <NativeSelectOption key={id} value={id}>
            {geminiModelLabel(id)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </SettingRow>
  )
}

function GeminiForm({ status }: { status: GeminiStatus }) {
  const [busy, setBusy] = useState(false)
  const { enabled, evaluator_decides: rulesDecide } = status.settings
  useInstallPoll(status.state === 'installing')
  const send = async (call: () => Promise<GeminiStatus>) => {
    setBusy(true)
    try {
      await call()
      refreshRuntimes()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const put = async (body: GeminiSettingsInput) => send(async () => apiPut<GeminiStatus>('/runtimes/gemini', body))
  const retry = async () => send(async () => apiPost<GeminiStatus>('/runtimes/gemini/retry'))
  return (
    <SettingsCard title="Gemini" actions={<StateWord status={status} words={WORDS} />}>
      <SettingRow
        label="Gemini agents"
        stack
        description="Lets new agents run on Google's Gemini models through Gemini CLI, always sandboxed."
      >
        <ToggleButton
          pressed={enabled}
          disabled={busy}
          onPressedChange={(on) => void put({ enabled: on })}
          icon={Gem}
          label="Gemini"
          hint={
            enabled
              ? 'Turn Gemini off: no new Gemini agents'
              : `Turn Gemini on: Seti installs Gemini CLI ${status.pinned} for new agents`
          }
        />
      </SettingRow>
      <InstallRow status={status} words={WORDS} busy={busy} retry={retry} />
      {enabled && <KeyRow status={status} words={WORDS} />}
      <SettingRow
        label="Rules decide"
        stack
        description="On by default: your allow rules and Seti's read-only list answer a Gemini agent's calls, and the rest ask you. Off: every call asks."
      >
        <ToggleButton
          pressed={rulesDecide}
          disabled={busy}
          onPressedChange={(on) => void put({ evaluator_decides: on })}
          icon={Scale}
          label="Rules"
          hint={rulesDecide ? 'Ask me about every Gemini call again' : 'Let allow rules answer Gemini calls'}
        />
      </SettingRow>
      <SettingRow
        label="Unasked"
        stack
        description="Gemini CLI runs a few read-only commands, such as cat, ls and grep, without asking. The sandbox is what limits them."
      >
        {null}
      </SettingRow>
      <DefaultModelRow status={status} busy={busy} put={put} />
    </SettingsCard>
  )
}

/** Gemini: off by default; on, Seti installs Gemini CLI, and the card shows its key and defaults. */
export function GeminiCard() {
  const { data, error } = useRuntimes()
  if (data === undefined) {
    return (
      <SettingsCard title="Gemini">
        <p className="px-3 py-3 text-muted-foreground">{error ?? 'Loading...'}</p>
      </SettingsCard>
    )
  }
  return <GeminiForm status={data.gemini} />
}
