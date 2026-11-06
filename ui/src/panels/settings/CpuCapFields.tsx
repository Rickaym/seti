import { coresLabel } from '@seti/shared'
import { Cpu } from 'lucide-react'
import { useId } from 'react'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { Input } from '@/components/ui/input'
import type { CpuCapForm } from './cpu-cap-form'

/** A CPU cap in cores behind a toggle, up to every core of the host. */
export function CpuCapFields({
  form,
  maxPercent,
  invalid,
  onChange,
  disabled = false,
}: {
  form: CpuCapForm
  maxPercent: number
  invalid: boolean
  onChange: (next: CpuCapForm) => void
  disabled?: boolean
}) {
  const explained = useId()
  return (
    <div className="space-y-1.5">
      <div role="group" aria-describedby={explained} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <ToggleButton
          pressed={form.limited}
          onPressedChange={(limited) => {
            onChange({ ...form, limited })
          }}
          icon={Cpu}
          label="CPU cap"
          hint={form.limited ? 'Turn off to let the agent use every core' : 'Hold the agent to a number of cores'}
          disabled={disabled}
        />
        {form.limited && (
          <label className="flex items-center gap-1.5">
            <Hint text={`From half a core up to this host's ${coresLabel(maxPercent)}`}>
              <Input
                aria-label="Cores"
                type="number"
                inputMode="decimal"
                min={0.5}
                max={maxPercent / 100}
                step={0.5}
                value={form.cores}
                aria-invalid={invalid}
                disabled={disabled}
                onChange={(event) => {
                  onChange({ ...form, cores: event.target.value })
                }}
                className="h-7 w-16"
              />
            </Hint>
            <span className="text-muted-foreground">of {coresLabel(maxPercent)}</span>
          </label>
        )}
      </div>
      <p id={explained} className="text-2xs text-muted-foreground">
        {form.limited
          ? 'At the cap the kernel pauses the agent until the next tenth of a second, so it runs slower instead of starving the rest.'
          : 'No cap: the agent may use every core, and only shares them fairly when others want them too.'}
      </p>
    </div>
  )
}
