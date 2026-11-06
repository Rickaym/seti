import type { CredentialProfile } from '@seti/shared'
import { Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiPatch, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { validName } from './summary'

export function BuiltinBadge() {
  return (
    <Hint text="Agents use it unless their details choose another set. It cannot be renamed or deleted.">
      <span className="relative shrink-0 border border-border px-1 text-2xs font-medium text-muted-foreground uppercase">
        Built-in
      </span>
    </Hint>
  )
}

/** A profile's name as its page title, renamed in place unless it is the built-in one. */
export function ProfileTitle({ profile, onRenamed }: { profile: CredentialProfile; onRenamed: () => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const editing = draft !== null
  useEffect(() => {
    if (editing) {
      input.current?.select()
    }
  }, [editing])

  const commit = async () => {
    if (draft === null || saving) {
      return
    }
    if (draft.trim() === profile.name) {
      setDraft(null)
      return
    }
    const valid = validName(draft)
    if (valid === null) {
      return
    }
    setSaving(true)
    try {
      await apiPatch<CredentialProfile>(`/credentials/profiles/${profile.id}`, { name: valid })
      toast.success(`Renamed to ${valid}`)
      setDraft(null)
      onRenamed()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  if (draft !== null) {
    return (
      <Input
        ref={input}
        aria-label="Name"
        disabled={saving}
        maxLength={40}
        className="h-8 w-80 min-w-0 text-lg font-semibold max-md:w-full max-md:text-base md:text-lg"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setDraft(null)
          }
        }}
      />
    )
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      <h2 className="min-w-0 truncate text-lg font-semibold max-md:text-base">{profile.name}</h2>
      {profile.builtin ? (
        <BuiltinBadge />
      ) : (
        <Hint text="Rename; its agents keep it">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Rename credential"
            className="-ml-1 shrink-0 text-muted-foreground"
            onClick={() => {
              setDraft(profile.name)
            }}
          >
            <Pencil />
          </Button>
        </Hint>
      )}
    </div>
  )
}
