import { Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * A page title renamed in place: double-click it or press the pencil, Enter saves, Escape or
 * leaving the field cancels. `onRename` says whether the new name was saved.
 */
export function RenameTitle({
  name,
  label,
  note,
  onRename,
}: {
  name: string
  /** What the pencil does, such as "Rename host"; the field is labelled "New name". */
  label: string
  /** A line under the field while renaming. */
  note?: string
  onRename: (next: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const editing = draft !== null
  useEffect(() => {
    if (editing) {
      input.current?.select()
    }
  }, [editing])
  const start = () => {
    setDraft(name)
  }
  const save = async () => {
    if (draft === null || saving) {
      return
    }
    if (draft.trim() === name) {
      setDraft(null)
      return
    }
    setSaving(true)
    const saved = await onRename(draft.trim())
    setSaving(false)
    if (saved) {
      setDraft(null)
    }
  }
  if (draft !== null) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Input
          ref={input}
          aria-label="New name"
          autoComplete="off"
          readOnly={saving}
          className="h-8 w-80 min-w-0 text-lg font-semibold max-md:w-full max-md:text-base md:text-lg"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onBlur={() => {
            if (!saving) {
              setDraft(null)
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void save()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setDraft(null)
            }
          }}
        />
        {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
    )
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- pencil is the keyboard way */}
      <h2 className="min-w-0 truncate text-lg font-semibold max-md:text-base" onDoubleClick={start}>
        {name}
      </h2>
      <Hint text={`${label}; Enter saves, Escape cancels`}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          className="-ml-1 shrink-0 text-muted-foreground"
          onClick={start}
        >
          <Pencil />
        </Button>
      </Hint>
    </div>
  )
}
