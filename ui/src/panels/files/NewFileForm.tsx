import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** Names a new text file in the open folder. */
export function NewFileForm({ onCreate, onCancel }: { onCreate: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    field.current?.focus()
  }, [])
  const clean = name.trim().replace(/^\/+/, '')
  const valid = clean !== '' && !clean.split('/').some((part) => part === '..' || part === '')
  return (
    <form
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid) {
          onCreate(clean)
        }
      }}
    >
      <Input
        ref={field}
        aria-label="New file name"
        placeholder="notes.md"
        value={name}
        onChange={(e) => {
          setName(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        className="h-7"
      />
      <Button type="submit" size="sm" disabled={!valid}>
        Create
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  )
}
