import { CODEX_EFFORTS, CODEX_MODELS, type CodexStatus } from '@seti/shared'
import { TerminalSquare } from 'lucide-react'
import { ToggleButton } from '@/components/ToggleButton'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { useRuntimes } from '@/hooks/useRuntimes'
import { CLAUDE_PICK, type RuntimePick } from '@/lib/runtime-pick'

const SELECT = 'h-7 text-xs pointer-coarse:h-10'

function CodexPicks({ pick, onChange, disabled }: ChoiceProps) {
  return (
    <>
      <NativeSelect
        aria-label="Model"
        size="sm"
        className={SELECT}
        value={pick.model ?? CODEX_MODELS[0]}
        disabled={disabled}
        onChange={(e) => {
          onChange({ ...pick, model: e.target.value })
        }}
      >
        {CODEX_MODELS.map((id) => (
          <NativeSelectOption key={id} value={id}>
            {id}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Effort"
        size="sm"
        className={SELECT}
        value={pick.effort ?? ''}
        disabled={disabled}
        onChange={(e) => {
          onChange({ ...pick, effort: e.target.value === '' ? null : e.target.value })
        }}
      >
        <NativeSelectOption value="">Effort</NativeSelectOption>
        {CODEX_EFFORTS.map((id) => (
          <NativeSelectOption key={id} value={id}>
            {id}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </>
  )
}

interface ChoiceProps {
  pick: RuntimePick
  onChange: (pick: RuntimePick) => void
  disabled: boolean
}

const codexPick = (status: CodexStatus): RuntimePick => ({
  codex: true,
  model: status.settings.default_model ?? CODEX_MODELS[0],
  effort: status.settings.default_effort,
})

/** Shown only while another runtime than Claude Code is ready, so most users never see it. */
export function RuntimeChoice({ pick, onChange, disabled }: ChoiceProps) {
  const codex = useRuntimes().data?.codex
  if (codex?.state !== 'ready') {
    return null
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <ToggleButton
        pressed={pick.codex}
        disabled={disabled}
        size="xs"
        variant="ghost"
        icon={TerminalSquare}
        label="Codex"
        hint={pick.codex ? 'Start it on Claude Code instead' : 'Start it on Codex, with an OpenAI model'}
        onPressedChange={(on) => {
          onChange(on ? codexPick(codex) : CLAUDE_PICK)
        }}
      />
      {pick.codex && <CodexPicks pick={pick} onChange={onChange} disabled={disabled} />}
    </div>
  )
}
