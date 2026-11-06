import { awsRoleName, DEFAULT_PROFILE_ID, type ProfileSummary, type Task, type TaskAccessView } from '@seti/shared'
import { RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPatch, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { SettingsLink } from '@/components/SettingsLink'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { SourceMark } from '@/panels/access/SourceMark'
import { noteAccessChange } from '@/panels/access/access'

const APPLIES = 'Applies from the next turn'

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
function ProfileSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const profiles = useProfiles()
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
      {(profiles ?? [{ id: value, name: value, builtin: true, agents: 0 }]).map((profile) => (
        <NativeSelectOption key={profile.id} value={profile.id}>
          {profile.name}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  )
}

/** The toast after a change: the role when AWS is on, since a credential with a role turns it on. */
const appliedText = (view: TaskAccessView) =>
  view.aws.state === 'on' ? `AWS on: ${awsRoleName(view.aws.role)}` : APPLIES

/**
 * Switches an agent's credentials at any time, a running turn included; the next turn uses them.
 * What the credential holds is managed on the Credentials page, which the link opens.
 */
export function TaskCredentials({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const custom = task.profile_id !== DEFAULT_PROFILE_ID
  const change = async (profileId: string) => {
    try {
      await apiPatch<Task>(`/tasks/${task.id}`, { profile_id: profileId })
      toast.success(appliedText(await apiGet<TaskAccessView>(`/tasks/${task.id}/access`)))
      noteAccessChange(task.id)
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ProfileSelect value={task.profile_id} onChange={(id) => void change(id)} />
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
            onClick={() => void change(DEFAULT_PROFILE_ID)}
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
