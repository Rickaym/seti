import { userSettingsInput, type UserSettings } from '@seti/shared'
import { Save } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPut, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useLeaveGuard } from '@/hooks/useLeaveGuard'
import { refreshUserName, useUserName } from '@/hooks/useUserName'
import { SettingRow, SettingsCard } from './layout'

const TITLE = 'Name'

function NameForm({ saved }: { saved: string }) {
  const [name, setName] = useState(saved)
  const [busy, setBusy] = useState(false)
  const dirty = name.trim() !== saved
  useLeaveGuard(dirty)

  const save = async () => {
    const input = userSettingsInput.safeParse({ name })
    if (!input.success) {
      toast.error(input.error.issues[0]?.message ?? 'Check the name')
      return
    }
    setBusy(true)
    try {
      await apiPut<UserSettings>('/user', input.data)
      refreshUserName()
      toast.success('Name saved')
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard
      title={TITLE}
      actions={
        <Button size="sm" onClick={() => void save()} disabled={!dirty || busy}>
          <Save />
          Save
        </Button>
      }
    >
      <SettingRow label="Your name" stack description="What the start page calls you, as in Your move, name.">
        <Input
          aria-label="Your name"
          value={name}
          maxLength={40}
          placeholder="First name"
          onChange={(e) => {
            setName(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty) {
              void save()
            }
          }}
          className="w-48 max-md:w-full"
        />
      </SettingRow>
    </SettingsCard>
  )
}

/** The name the start page greets the user by. */
export function NameCard() {
  const saved = useUserName()
  if (saved === null) {
    return (
      <SettingsCard title={TITLE}>
        <p className="p-3 text-muted-foreground">Loading...</p>
      </SettingsCard>
    )
  }
  return <NameForm key={saved} saved={saved} />
}
