import { Code, PencilLine, PencilOff, Save, Search } from 'lucide-react'
import { CopyIconButton } from '@/components/CopyButton'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'
import { FILE_KEYS } from '@/panels/files/find/find-keys'

/** Whether a diagram or table shows its text, and the switch between the two. */
export interface SourceToggle {
  pressed: boolean
  onChange: (pressed: boolean) => void
}

interface EditActionsProps {
  /** The text shown or being edited, which Copy contents copies. */
  text: string
  writable: boolean
  editing: boolean
  dirty: boolean
  saving: boolean
  source: SourceToggle | null
  /** Opens find in the file, or null where the view has no text to search. */
  onFind: (() => void) | null
  onEdit: (editing: boolean) => void
  onSave: () => void
}

/** Find, Edit, or Save and Stop editing while editing, and the Source toggle, for the header. */
export function EditActions({
  text,
  writable,
  editing,
  dirty,
  saving,
  source,
  onFind,
  onEdit,
  onSave,
}: EditActionsProps) {
  return (
    <>
      <CopyIconButton text={text} label="Copy contents" variant="outline" />
      {onFind !== null && (
        <Hint text={`Find in this file (${FILE_KEYS.find})`}>
          <Button variant="outline" size="icon-sm" aria-label="Find in file" onClick={onFind}>
            <Search />
          </Button>
        </Hint>
      )}
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
        <Hint text={`Save (${FILE_KEYS.save})`}>
          <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
            <Save />
            <span className="max-sm:sr-only">{saving ? 'Saving...' : 'Save'}</span>
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
