import { Gauge } from 'lucide-react'
import { useId } from 'react'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { Input } from '@/components/ui/input'
import type { MemoryCapForm } from './memory-cap-form'

type SizeKey = 'max' | 'swap' | 'high'

/** `shown` is the visible label; `name` the input's accessible name, specific out of context. */
const FIELDS: Record<SizeKey, { shown: string; name: string; hint: string }> = {
  max: { shown: 'RAM', name: 'RAM cap', hint: 'Above this the kernel stops the largest process of the agent' },
  swap: { shown: 'Swap', name: 'Swap cap', hint: 'How much of the agent may be swapped out' },
  high: { shown: 'at', name: 'Soft cap', hint: 'Above this the kernel slows the agent down to reclaim memory' },
}

const EXPLAIN = {
  sizes: "Over the RAM cap the kernel stops the agent's largest process; swap is how much may go to disk.",
  off: 'A soft cap slows the agent down before the RAM cap instead. Advanced.',
  on: 'Over the soft cap the kernel slows the agent; with swap full it can stall for minutes.',
}

function SizeField({
  field,
  form,
  invalid,
  disabled,
  onChange,
}: {
  field: SizeKey
  form: MemoryCapForm
  invalid: boolean
  disabled: boolean
  onChange: (next: MemoryCapForm) => void
}) {
  const { shown, name, hint } = FIELDS[field]
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{shown}</span>
      <Hint text={hint}>
        <Input
          aria-label={name}
          type="number"
          inputMode="decimal"
          min={0}
          step={0.5}
          value={form[field]}
          aria-invalid={invalid}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...form, [field]: event.target.value })
          }}
          className="h-7 w-16"
        />
      </Hint>
      <span className="text-muted-foreground">GB</span>
    </label>
  )
}

/** The RAM and swap caps of a memory cap in GB, and an optional soft cap behind a toggle. */
export function MemoryCapFields({
  form,
  invalid,
  onChange,
  disabled = false,
}: {
  form: MemoryCapForm
  invalid: boolean
  onChange: (next: MemoryCapForm) => void
  disabled?: boolean
}) {
  const props = { form, invalid, disabled, onChange }
  const explained = useId()
  return (
    <div className="space-y-1.5">
      <div role="group" aria-describedby={explained} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <SizeField field="max" {...props} />
        <SizeField field="swap" {...props} />
        <ToggleButton
          pressed={form.throttle}
          onPressedChange={(throttle) => {
            onChange({ ...form, throttle })
          }}
          icon={Gauge}
          label="Soft cap"
          hint={form.throttle ? 'Turn off to go straight to the RAM cap' : 'Slow the agent down before the RAM cap'}
        />
        {form.throttle && <SizeField field="high" {...props} />}
      </div>
      <p id={explained} className="text-2xs text-muted-foreground">
        {EXPLAIN.sizes} {form.throttle ? EXPLAIN.on : EXPLAIN.off}
      </p>
    </div>
  )
}
