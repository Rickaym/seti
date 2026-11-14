import type { ConnectionSlot } from '@seti/shared'
import { PlainTextarea } from '@/components/find/FindableTextarea'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { MULTILINE, SLOT_LABEL } from './connection-form'

/** A write-only box for one value: masked for a key, several lines for a PEM key or key file. */
export function ValueInput({
  slot,
  value,
  placeholder,
  className,
  onChange,
}: {
  slot: ConnectionSlot
  value: string
  placeholder: string
  className?: string
  onChange: (value: string) => void
}) {
  const label = SLOT_LABEL[slot]
  if (MULTILINE.has(slot)) {
    return (
      <PlainTextarea
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        className={cn('min-h-8 font-mono [-webkit-text-security:disc]', className)}
        rows={2}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      />
    )
  }
  return (
    <Input
      aria-label={label}
      type="password"
      autoComplete="off"
      className={cn('font-mono', className)}
      placeholder={placeholder}
      value={value}
      onChange={(event) => {
        onChange(event.target.value)
      }}
    />
  )
}
