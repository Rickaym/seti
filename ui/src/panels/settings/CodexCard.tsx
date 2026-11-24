import {
  CODEX_EFFORTS,
  CODEX_MODELS,
  DEFAULT_PROFILE_ID,
  type CodexSettingsInput,
  type CodexState,
  type CodexStatus,
} from '@seti/shared'
import { CircleCheck, CircleDashed, KeyRound, Save, Scale, TerminalSquare } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { useLeaveGuard } from '@/hooks/useLeaveGuard'
import { refreshRuntimes, useRuntimes } from '@/hooks/useRuntimes'
import { navigate } from '@/lib/route'
import { SettingRow, SettingsCard } from './layout'

const STATE_WORDS: Record<CodexState, string> = {
  off: 'Off',
  not_set_up: 'Not set up',
  missing: 'Missing',
  update_needed: 'Update needed',
  no_key: 'No key',
  ready: 'Ready',
}

const STATE_HINTS: Record<CodexState, string> = {
  off: 'No agent can start on Codex until you turn it on',
  not_set_up: 'Name the codex program below',
  missing: 'The program below is not there or does not run',
  update_needed: 'The program below is not the version this Seti needs',
  no_key: 'The default credential, which new agents get, has no OpenAI key yet',
  ready: 'New agents can start on Codex',
}

const DEFAULT = ''

/** The listed value the select chose, or null for the default. */
const pick = <T extends string>(list: readonly T[], value: string): T | null =>
  list.find((item) => item === value) ?? null

function StateWord({ status }: { status: CodexStatus }) {
  const Icon = status.state === 'ready' ? CircleCheck : CircleDashed
  return (
    <Hint text={STATE_HINTS[status.state]}>
      <span role="status" className="flex items-center gap-1 text-muted-foreground">
        <Icon className="size-3.5" />
        {STATE_WORDS[status.state]}
      </span>
    </Hint>
  )
}

function versionLine(status: CodexStatus): string {
  const found = status.version === null ? 'none found' : `found ${status.version}`
  return `The absolute path of the codex program, version ${status.pinned}; ${found}.`
}

function ProgramRow({ status, busy, put }: RowProps) {
  const [program, setProgram] = useState(status.settings.program ?? '')
  const dirty = program.trim() !== (status.settings.program ?? '')
  useLeaveGuard(dirty)
  return (
    <SettingRow label="Program" stack description={versionLine(status)}>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Program"
          value={program}
          placeholder="/path/to/codex"
          className="w-64 font-mono max-md:w-full"
          onChange={(e) => {
            setProgram(e.target.value)
          }}
        />
        <Button
          size="sm"
          disabled={!dirty || busy}
          onClick={() => void put({ program: program.trim() === '' ? null : program.trim() })}
        >
          <Save />
          Save
        </Button>
      </div>
    </SettingRow>
  )
}

/** Whether the default credential holds an OpenAI key, and where the user adds one; never a value. */
function keyLine(keyed: readonly string[]): string {
  if (keyed.includes(DEFAULT_PROFILE_ID)) {
    return 'The default credential holds one, so new agents get it.'
  }
  return 'Add it in Connections: a connection with a header on api.openai.com, in the default credential.'
}

function KeyRow({ keyed }: { keyed: readonly string[] }) {
  return (
    <SettingRow label="OpenAI key" stack description={keyLine(keyed)}>
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
    </SettingRow>
  )
}

function DefaultsRow({ status, busy, put }: RowProps) {
  const { default_model: model, default_effort: effort } = status.settings
  return (
    <SettingRow
      label="Model"
      stack
      description="Only models this Codex version sends its tools for are offered. Cost is estimated."
    >
      <div className="flex items-center gap-2">
        <NativeSelect
          aria-label="Default model"
          value={model ?? DEFAULT}
          disabled={busy}
          onChange={(e) => void put({ default_model: pick(CODEX_MODELS, e.target.value) })}
        >
          <NativeSelectOption value={DEFAULT}>Default</NativeSelectOption>
          {CODEX_MODELS.map((id) => (
            <NativeSelectOption key={id} value={id}>
              {id}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Default effort"
          value={effort ?? DEFAULT}
          disabled={busy}
          onChange={(e) => void put({ default_effort: pick(CODEX_EFFORTS, e.target.value) })}
        >
          <NativeSelectOption value={DEFAULT}>Default effort</NativeSelectOption>
          {CODEX_EFFORTS.map((id) => (
            <NativeSelectOption key={id} value={id}>
              {id}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
    </SettingRow>
  )
}

interface RowProps {
  status: CodexStatus
  busy: boolean
  put: (body: CodexSettingsInput) => Promise<void>
}

function CodexForm({ status }: { status: CodexStatus }) {
  const [busy, setBusy] = useState(false)
  const { enabled, evaluator_decides: rulesDecide } = status.settings
  const put = async (body: CodexSettingsInput) => {
    setBusy(true)
    try {
      await apiPut<CodexStatus>('/runtimes/codex', body)
      refreshRuntimes()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsCard title="Codex" actions={<StateWord status={status} />}>
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
          hint={enabled ? 'Turn Codex off: no new Codex agents' : 'Turn Codex on for new agents'}
        />
      </SettingRow>
      <ProgramRow key={status.settings.program ?? ''} status={status} busy={busy} put={put} />
      <KeyRow keyed={status.keyed} />
      <DefaultsRow status={status} busy={busy} put={put} />
      <SettingRow
        label="Rules decide"
        stack
        description="Lets your allow rules and Seti's read-only list answer a Codex agent's calls without asking you. Off: every call asks."
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
      <p className="px-3 py-2 text-muted-foreground">Prices as of {status.pricesAsOf}</p>
    </SettingsCard>
  )
}

/** Codex: off by default, the program it starts, its key, defaults and who answers its calls. */
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
