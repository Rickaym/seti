import { Pencil } from 'lucide-react'
import { Hint } from '@/components/Hint'

/** Marks a call the user edited before they answered it, naming the fields in its tooltip. */
export function EditedLine({ fields, denied }: { fields: readonly string[]; denied: boolean }) {
  const names = fields.join(', ')
  const hint = denied
    ? `You edited ${names}, then denied the call; the agent got your text`
    : `You edited ${names} before the call ran; the agent was told`
  return (
    <Hint text={hint}>
      <span
        role="img"
        aria-label={`Edited: ${hint}`}
        data-testid="edited-mark"
        className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground"
      >
        <Pencil className="size-3.5 shrink-0" aria-hidden />
        Edited
      </span>
    </Hint>
  )
}
