import { COMPACT_INSTRUCTIONS_MAX } from '@seti/shared'
import { FoldVertical } from 'lucide-react'
import { useId } from 'react'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { CompactForm } from './compact-form'

const EXPLAIN = {
  window:
    'Context window: the size to compact against, 100k to 1000k tokens; compaction starts about 33k short of it. Blank leaves it to Claude Code, which for most models waits until the conversation is too long to send.',
  pct: 'Compact at: earlier, at this share of the window; needs a context window.',
  off: 'Off, the conversation compacts only when you send /compact.',
}

function NumberField({
  label,
  unit,
  hint,
  value,
  placeholder,
  invalid,
  disabled,
  onChange,
}: {
  label: string
  unit: string
  hint: string
  value: string
  placeholder: string
  invalid: boolean
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <Hint text={hint}>
        <Input
          aria-label={label}
          type="number"
          inputMode="numeric"
          placeholder={placeholder}
          value={value}
          aria-invalid={invalid}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value)
          }}
          className="h-7 w-18"
        />
      </Hint>
      <span className="text-muted-foreground">{unit}</span>
    </label>
  )
}

/** Auto compact on or off, its context window and point, and what every summary should keep. */
export function CompactFields({
  form,
  invalid,
  onChange,
  disabled = false,
}: {
  form: CompactForm
  invalid: boolean
  onChange: (next: CompactForm) => void
  disabled?: boolean
}) {
  const explained = useId()
  const off = disabled || !form.auto
  return (
    <div className="w-full space-y-2 break-normal">
      <div role="group" aria-describedby={explained} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <ToggleButton
          pressed={form.auto}
          disabled={disabled}
          onPressedChange={(auto) => {
            onChange({ ...form, auto })
          }}
          icon={FoldVertical}
          label="Auto compact"
          hint={form.auto ? 'Compact only when /compact is sent' : 'Compact as the context fills'}
        />
        <NumberField
          label="Context window"
          unit="k tokens"
          hint="The context size to compact against; blank for Claude Code's own"
          value={form.window}
          placeholder="auto"
          invalid={invalid}
          disabled={off}
          onChange={(window) => {
            onChange({ ...form, window })
          }}
        />
        <NumberField
          label="Compact at"
          unit="%"
          hint="Compact earlier, at this share of the window"
          value={form.pct}
          placeholder="-"
          invalid={invalid}
          disabled={off || form.window.trim() === ''}
          onChange={(pct) => {
            onChange({ ...form, pct })
          }}
        />
      </div>
      <p id={explained} className="text-2xs text-muted-foreground">
        {form.auto ? `${EXPLAIN.window} ${EXPLAIN.pct}` : EXPLAIN.off}
      </p>
      <Textarea
        aria-label="Compact instructions"
        placeholder="What each summary keeps, such as the files changed and open decisions"
        maxLength={COMPACT_INSTRUCTIONS_MAX}
        value={form.instructions}
        disabled={disabled}
        onChange={(event) => {
          onChange({ ...form, instructions: event.target.value })
        }}
        className="min-h-14"
      />
    </div>
  )
}
