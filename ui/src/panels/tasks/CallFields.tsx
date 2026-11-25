import { Pencil } from 'lucide-react'
import { useId } from 'react'
import { FindableTextarea } from '@/components/find/FindableTextarea'
import { Button } from '@/components/ui/button'
import type { CallFieldValues } from '@/panels/tasks/use-call-fields'

/** A box for each text field of the call, labelled with the field's name, while editing. */
export function CallFields({ fields, editing }: { fields: CallFieldValues; editing: boolean }) {
  const id = useId()
  if (!editing) {
    return null
  }
  return (
    <div role="group" aria-label="Call fields" className="flex flex-col gap-1.5">
      {Object.entries(fields.values).map(([key, value], index) => (
        <div key={key} className="flex flex-col gap-0.5">
          <label htmlFor={`${id}-${String(index)}`} className="font-mono text-2xs text-muted-foreground">
            {key}
          </label>
          <FindableTextarea
            id={`${id}-${String(index)}`}
            value={value}
            rows={Math.min(8, Math.max(1, value.split('\n').length))}
            className="min-h-8 font-mono text-xs"
            onChange={(event) => {
              fields.set(key, event.target.value)
            }}
          />
        </div>
      ))}
    </div>
  )
}

interface EditProps {
  editable: boolean
  editing: boolean
  busy: boolean
  className: string
  onEdit: () => void
}

/** Opens the call's fields for editing; shown only for an editable call not open yet. */
export function EditButton({ editable, editing, busy, className, onEdit }: EditProps) {
  if (!editable || editing) {
    return null
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      className={className}
      disabled={busy}
      title="Change the call's text before it runs"
      onClick={onEdit}
    >
      <Pencil />
      Edit
    </Button>
  )
}

/** Says which fields the user changed: Allow runs them, and Deny shows them to the agent. */
export function EditedNote({ edited }: { edited: readonly string[] }) {
  if (edited.length === 0) {
    return null
  }
  return (
    <p className="text-2xs text-muted-foreground">
      Allow runs it with your edits to <span className="font-mono">{edited.join(', ')}</span>; Deny shows the agent your
      edits.
    </p>
  )
}
