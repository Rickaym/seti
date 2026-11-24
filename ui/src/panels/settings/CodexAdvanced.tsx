import { CODEX_EFFORTS, CODEX_MODELS, type CodexSettingsInput, type CodexStatus } from '@seti/shared'
import { ChevronRight, Save } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { useLeaveGuard } from '@/hooks/useLeaveGuard'
import { SettingRow } from './layout'

export interface CodexRowProps {
  status: CodexStatus
  busy: boolean
  put: (body: CodexSettingsInput) => Promise<void>
}

const DEFAULT = ''

/** The listed value the select chose, or null for the default. */
const pick = <T extends string>(list: readonly T[], value: string): T | null =>
  list.find((item) => item === value) ?? null

/** A codex program of the user's in place of Seti's copy, for a machine without network access. */
function OwnProgramRow({ status, busy, put }: CodexRowProps) {
  const [program, setProgram] = useState(status.settings.program ?? '')
  const dirty = program.trim() !== (status.settings.program ?? '')
  useLeaveGuard(dirty)
  return (
    <SettingRow
      label="Own program"
      stack
      description={`Only for a machine without network access: the absolute path of a codex program, version ${status.pinned}. Empty, Seti installs its own copy.`}
    >
      <div className="flex items-center gap-2">
        <Input
          aria-label="Own program"
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

function DefaultsRow({ status, busy, put }: CodexRowProps) {
  const { default_model: model, default_effort: effort } = status.settings
  return (
    <SettingRow
      label="Defaults"
      stack
      description={`The model and effort a new Codex agent starts with unless it picks its own. Cost is an estimate from prices as of ${status.pricesAsOf}.`}
    >
      <div className="flex items-center gap-2">
        <NativeSelect
          aria-label="Default model"
          value={model ?? DEFAULT}
          disabled={busy}
          onChange={(e) => void put({ default_model: pick(CODEX_MODELS, e.target.value) })}
        >
          <NativeSelectOption value={DEFAULT}>Default model</NativeSelectOption>
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

/** What few setups need, folded away: a program of the user's and the defaults of new agents. */
export function CodexAdvanced(props: CodexRowProps) {
  const own = props.status.settings.program !== null
  return (
    <Collapsible className="group/advanced border-b border-border">
      <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/advanced:rotate-90" />
        <span className="font-medium">Advanced</span>
        <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
          {own ? 'Own program' : 'Seti installs Codex'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border">
        <OwnProgramRow key={props.status.settings.program ?? ''} {...props} />
        <DefaultsRow {...props} />
      </CollapsibleContent>
    </Collapsible>
  )
}
