import { Code, PencilLine, PencilOff, Save } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'

/** Whether a diagram or table shows its text, and the switch between the two. */
export interface SourceToggle {
  pressed: boolean
  onChange: (pressed: boolean) => void
}

interface EditActionsProps {
  writable: boolean
  editing: boolean
  dirty: boolean
  saving: boolean
  source: SourceToggle | null
  onEdit: (editing: boolean) => void
  onSave: () => void
}

/** Edit, or Save and Stop editing while editing, plus the Source toggle, for the viewer header. */
export function EditActions({ writable, editing, dirty, saving, source, onEdit, onSave }: EditActionsProps) {
  return (
    <>
      {source !== null && !editing && (
        <ToggleButton
          pressed={source.pressed}
          onPressedChange={source.onChange}
          icon={Code}
          label="Source"
          iconOnly
          hint={source.pressed ? 'Back to the rendered view' : 'Show the text'}
        />
      )}
      {dirty && <span className="text-xs text-muted-foreground max-sm:hidden">Unsaved changes</span>}
      {editing && (
        <Hint text="Save (Ctrl+S)">
          <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
            <Save />
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </Hint>
      )}
      {writable && editing && (
        <Hint text="Back to the view; asks before dropping unsaved changes">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Stop editing"
            onClick={() => {
              onEdit(false)
            }}
          >
            <PencilOff />
          </Button>
        </Hint>
      )}
      {writable && !editing && (
        <Hint text="Edit this file">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Edit"
            onClick={() => {
              onEdit(true)
            }}
          >
            <PencilLine />
          </Button>
        </Hint>
      )}
    </>
  )
}
