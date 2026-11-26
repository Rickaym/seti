import { DEFAULT_PROFILE_ID, type ProfileSummary, type Task } from '@seti/shared'
import { RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { SettingsLink } from '@/components/SettingsLink'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { SourceMark } from '@/panels/access/SourceMark'
import { useCredentialSwitch } from './useCredentialSwitch'

function useProfiles(): ProfileSummary[] | null {
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null)
  useEffect(() => {
    apiGet<ProfileSummary[]>('/credential-profiles')
      .then(setProfiles)
      .catch((e: unknown) => {
        setProfiles([])
        toast.error(errorText(e))
      })
  }, [])
  return profiles
}

/** The credentials a sandboxed agent's proxy takes its tokens from. */
function ProfileSelect({
  value,
  profiles,
  onChange,
}: {
  value: string
  profiles: ProfileSummary[] | null
  onChange: (id: string) => void
}) {
  return (
    <NativeSelect
      aria-label="Credentials"
      size="sm"
      value={value}
      disabled={profiles === null}
      onChange={(event) => {
        onChange(event.target.value)
      }}
    >
      {(profiles ?? [{ id: value, name: value, builtin: true, agents: 0, access_items: 0 }]).map((profile) => (
        <NativeSelectOption key={profile.id} value={profile.id}>
          {profile.name}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  )
}

/**
 * Switches an agent's credentials at any time, a running turn included; the next turn uses them.
 * What the credential holds is managed on the Credentials page, which the link opens.
 */
export function TaskCredentials({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const custom = task.profile_id !== DEFAULT_PROFILE_ID
  const profiles = useProfiles()
  const { choose: switchTo, dialog } = useCredentialSwitch(task, onChanged)
  const choose = (id: string) => {
    switchTo(
      id,
      profiles?.find((entry) => entry.id === id),
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ProfileSelect value={task.profile_id} profiles={profiles} onChange={choose} />
      {dialog}
      <SourceMark
        custom={custom}
        hint={
          custom
            ? "This agent's own choice; agents inherit the Default set."
            : 'Inherited: agents use the Default set unless they choose another.'
        }
      />
      {custom && (
        <Hint text="Back to Default">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Reset credentials to Default"
            onClick={() => {
              choose(DEFAULT_PROFILE_ID)
            }}
          >
            <RotateCcw />
          </Button>
        </Hint>
      )}
      <span className="text-2xs">
        <SettingsLink page="credentials" detail={task.profile_id} label="Manage in Settings, Credentials">
          Manage
        </SettingsLink>
      </span>
    </div>
  )
}
