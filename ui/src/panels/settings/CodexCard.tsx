import {
  DEFAULT_PROFILE_ID,
  type CodexFailure,
  type CodexSettingsInput,
  type CodexState,
  type CodexStatus,
} from '@seti/shared'
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  KeyRound,
  Loader2,
  RotateCw,
  Scale,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiPost, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'
import { refreshRuntimes, useRuntimes } from '@/hooks/useRuntimes'
import { navigate } from '@/lib/route'
import { cn } from '@/lib/utils'
import { CodexAdvanced, type CodexRowProps } from './CodexAdvanced'
import { SettingRow, SettingsCard } from './layout'

const STATES: Record<CodexState, { word: string; icon: LucideIcon }> = {
  off: { word: 'Off', icon: CircleDashed },
  installing: { word: 'Installing', icon: Loader2 },
  failed: { word: 'Failed', icon: CircleAlert },
  no_key: { word: 'No key', icon: KeyRound },
  ready: { word: 'Ready', icon: CircleCheck },
}

function stateHint(status: CodexStatus): string {
  switch (status.state) {
    case 'off':
      return 'No agent can start on Codex until you turn it on'
    case 'installing':
      return `Seti is installing Codex ${status.pinned}`
    case 'failed':
      return status.failure?.message ?? 'Codex cannot start'
    case 'no_key':
      return 'The default credential, which new agents get, has no OpenAI key yet'
    case 'ready':
      return 'New agents can start on Codex'
  }
}

/** How often the card asks again while Codex installs, so Ready shows soon after it lands. */
const INSTALL_POLL_MS = 2000

function StateWord({ status }: { status: CodexStatus }) {
  const { word, icon: Icon } = STATES[status.state]
  return (
    <Hint text={stateHint(status)}>
      <span
        role="status"
        className={cn(
          'flex items-center gap-1',
          status.state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        <Icon className={cn('size-3.5', status.state === 'installing' && 'animate-spin')} />
        {word}
      </span>
    </Hint>
  )
}

const FAILURE_WORDS: Record<CodexFailure, string> = {
  network: 'Download failed',
  checksum: 'Checksum mismatch',
  platform: 'Unsupported machine',
  disk: 'Disk',
  missing: 'Not installed',
  program: 'Own program',
}

interface InstallRowProps {
  status: CodexStatus
  busy: boolean
  retry: () => Promise<void>
}

/** While Codex installs or after it failed: what happens, or why it stopped, with Retry. */
function InstallRow({ status, busy, retry }: InstallRowProps) {
  if (status.state === 'installing') {
    return (
      <SettingRow
        label="Installing"
        description={`Codex ${status.pinned} from the npm registry; it runs only once both checksums match.`}
      >
        <Loader2 aria-hidden className="size-4 animate-spin text-muted-foreground" />
      </SettingRow>
    )
  }
  if (status.failure === null) {
    return null
  }
  return (
    <SettingRow label={FAILURE_WORDS[status.failure.reason]} stack description={status.failure.message}>
      <Hint text="Try the install or the check again">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void retry()}>
          <RotateCw />
          Retry
        </Button>
      </Hint>
    </SettingRow>
  )
}

/** Whether new agents get an OpenAI key, never a value, and where the user adds one. */
function keyLine(status: CodexStatus): string {
  if (status.keyed.includes(DEFAULT_PROFILE_ID)) {
    return 'New agents get the key in the default credential.'
  }
  if (status.keyElsewhere !== null) {
    return `Your connection ${status.keyElsewhere} holds a key but is not in the default credential; add it there in Connections.`
  }
  return 'New agents get none yet: add your OpenAI key in Connections, in the default credential.'
}

function KeyRow({ status }: { status: CodexStatus }) {
  const keyed = status.keyed.includes(DEFAULT_PROFILE_ID)
  return (
    <SettingRow label="OpenAI key" stack description={keyLine(status)}>
      {keyed ? null : (
        <Hint text="Keys live in Connections; this page never changes them">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              navigate('settings', 'connections')
            }}
          >
            <KeyRound />
            Connections
          </Button>
        </Hint>
      )}
    </SettingRow>
  )
}

/** Asks for the state again every few seconds while Codex installs. */
function useInstallPoll(installing: boolean): void {
  useEffect(() => {
    if (!installing) {
      return undefined
    }
    const timer = setInterval(refreshRuntimes, INSTALL_POLL_MS)
    return () => {
      clearInterval(timer)
    }
  }, [installing])
}

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
    <SettingsCard title="Codex" actions={<StateWord status={status} />}>
      <SettingRow
        label="Codex agents"
        stack
        description="Agents on OpenAI's models, sandboxed. They ask before every command and edit."
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
      <InstallRow status={status} busy={busy} retry={retry} />
      {enabled && <KeyRow status={status} />}
      <SettingRow
        label="Rules decide"
        stack
        description="On, your allow rules and Seti's read-only list answer a Codex agent's calls without asking you."
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
