import { RUNTIME_NAMES, type RuntimeOffer } from '@seti/shared'
import { BrainCircuit, Gauge, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from '@/components/ui/native-select'
import { useRuntimes } from '@/hooks/useRuntimes'
import { effortsOf, modelGroups, pickOf, pickValue, type RuntimePick } from '@/lib/runtime-pick'

const DEFAULT_EFFORT = ''

interface IconSelectProps {
  icon: LucideIcon
  label: string
  hint: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
  children: ReactNode
}

/** A native select led by its icon, which a phone opens as its own picker, 44px tall to touch. */
export function IconSelect({ icon: Icon, label, hint, value, disabled, onChange, children }: IconSelectProps) {
  return (
    <Hint text={hint}>
      <span className="relative flex min-w-0 items-center">
        <Icon aria-hidden className="pointer-events-none absolute left-2 z-10 size-3.5 text-muted-foreground" />
        <NativeSelect
          aria-label={label}
          className="min-w-0 [&_select]:h-7 [&_select]:pl-7 pointer-coarse:[&_select]:h-11"
          value={value}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value)
          }}
        >
          {children}
        </NativeSelect>
      </span>
    </Hint>
  )
}

const modelHint = (pick: RuntimePick) =>
  `Runs on ${RUNTIME_NAMES[pick.runtime]} with ${pick.model ?? 'your default model'}. The model picks the runtime.`

interface PickerProps {
  pick: RuntimePick
  offers: readonly RuntimeOffer[]
  onChange: (pick: RuntimePick) => void
  disabled: boolean
}

function EffortSelect({ pick, offers, onChange, disabled }: PickerProps) {
  const efforts = effortsOf(pick, offers)
  if (efforts.length === 0) {
    return null
  }
  return (
    <IconSelect
      icon={Gauge}
      label="Effort"
      hint="Reasoning effort; Default leaves it to the runtime"
      value={pick.effort ?? DEFAULT_EFFORT}
      disabled={disabled}
      onChange={(value) => {
        onChange({ ...pick, effort: value === DEFAULT_EFFORT ? null : value })
      }}
    >
      <NativeSelectOption value={DEFAULT_EFFORT}>Default</NativeSelectOption>
      {efforts.map((effort) => (
        <NativeSelectOption key={effort} value={effort}>
          {effort}
        </NativeSelectOption>
      ))}
    </IconSelect>
  )
}

/**
 * The model a new agent runs on, grouped by runtime, and its effort where the model takes one.
 * Hidden while the default model is the only one to pick.
 */
export function ModelPicker({ pick, onChange, disabled }: Omit<PickerProps, 'offers'>) {
  const offers = useRuntimes().data?.offers ?? []
  const groups = modelGroups(offers)
  if (groups.flatMap((group) => group.options).length < 2) {
    return null
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <IconSelect
        icon={BrainCircuit}
        label="Model"
        hint={modelHint(pick)}
        value={pickValue(pick)}
        disabled={disabled}
        onChange={(value) => {
          const next = pickOf(value, offers)
          if (next !== null) {
            onChange(next)
          }
        }}
      >
        {groups.map((group) => (
          <NativeSelectOptGroup key={group.runtime} label={group.label}>
            {group.options.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelectOptGroup>
        ))}
      </IconSelect>
      <EffortSelect pick={pick} offers={offers} onChange={onChange} disabled={disabled} />
    </div>
  )
}
