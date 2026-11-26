import type { CodexSettingsInput, CodexStatus } from '@seti/shared'
import { Scale, TerminalSquare } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, apiPut, errorText } from '@/api'
import { ToggleButton } from '@/components/ToggleButton'
import { useInstallPoll } from '@/hooks/useInstallPoll'
import { refreshRuntimes, useRuntimes } from '@/hooks/useRuntimes'
import { CodexAdvanced, type CodexRowProps } from './CodexAdvanced'
import { InstallRow, KeyRow, StateWord, type RuntimeWords } from './RuntimeParts'
import { SettingRow, SettingsCard } from './layout'

const WORDS: RuntimeWords = { name: 'Codex', program: 'Codex', key: 'OpenAI' }

function CodexForm({ status }: { status: CodexStatus }) {
  const [busy, setBusy] = useState(false)
  const { enabled, evaluator_decides: rulesDecide } = status.settings
  useInstallPoll(status.state === 'installing')
  const send = async (call: () => Promise<CodexStatus>) => {
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
  const put = async (body: CodexSettingsInput) => send(async () => apiPut<CodexStatus>('/runtimes/codex', body))
  const retry = async () => send(async () => apiPost<CodexStatus>('/runtimes/codex/retry'))
  const rows: CodexRowProps = { status, busy, put }
  return (
    <SettingsCard title="Codex" actions={<StateWord status={status} words={WORDS} />}>
      <SettingRow
        label="Codex agents"
        stack
        description="Lets new agents run on OpenAI's models through Codex, always sandboxed."
      >
        <ToggleButton
          pressed={enabled}
          disabled={busy}
          onPressedChange={(on) => void put({ enabled: on })}
          icon={TerminalSquare}
          label="Codex"
          hint={
            enabled
              ? 'Turn Codex off: no new Codex agents, and Seti removes its copy'
              : `Turn Codex on: Seti installs Codex ${status.pinned} for new agents`
          }
        />
      </SettingRow>
      <InstallRow status={status} words={WORDS} busy={busy} retry={retry} />
      {enabled && <KeyRow status={status} words={WORDS} />}
      <SettingRow
        label="Rules decide"
        stack
        description="On by default: your allow rules and Seti's read-only list answer a Codex agent's calls, and the rest ask you. Off: every call asks."
      >
        <ToggleButton
          pressed={rulesDecide}
          disabled={busy}
          onPressedChange={(on) => void put({ evaluator_decides: on })}
          icon={Scale}
          label="Rules"
          hint={rulesDecide ? 'Ask me about every Codex call again' : 'Let allow rules answer Codex calls'}
        />
      </SettingRow>
      <CodexAdvanced {...rows} />
    </SettingsCard>
  )
}

/** Codex: off by default; on, Seti installs it, and the card shows its key and who answers calls. */
export function CodexCard() {
  const { data, error } = useRuntimes()
  if (data === undefined) {
    return (
      <SettingsCard title="Codex">
        <p className="px-3 py-3 text-muted-foreground">{error ?? 'Loading...'}</p>
      </SettingsCard>
    )
  }
  return <CodexForm status={data.codex} />
}
