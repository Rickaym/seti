import { awsRoleName, type ProfileSummary, type Task, type TaskAccessView } from '@seti/shared'
import { useState, type ReactElement } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPatch, errorText } from '@/api'
import { noteAccessChange } from '@/panels/access/access'
import { PickCredentialDialog } from './PickCredentialDialog'
import { pickConsequence, type PickConsequence } from './pick-consequence'

const APPLIES = 'Applies from the next turn'

/** The toast after a change: the role when AWS is on, since a credential with a role turns it on. */
const appliedText = (view: TaskAccessView) =>
  view.aws.state === 'on' ? `AWS on: ${awsRoleName(view.aws.role)}` : APPLIES

/** Switches the agent to a credential, asking first in a dialog when the switch changes access. */
export function useCredentialSwitch(
  task: Task,
  onChanged: () => void,
): { choose: (id: string, profile: ProfileSummary | undefined) => void; dialog: ReactElement | null } {
  const [pick, setPick] = useState<PickConsequence | null>(null)
  const change = async (profileId: string, reset = false) => {
    setPick(null)
    try {
      await apiPatch<Task>(`/tasks/${task.id}`, { profile_id: profileId, ...(reset ? { reset_access: true } : {}) })
      toast.success(appliedText(await apiGet<TaskAccessView>(`/tasks/${task.id}/access`)))
      noteAccessChange(task.id)
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  /** A credential not listed, such as Default while the list failed, switches without asking. */
  const choose = (id: string, profile: ProfileSummary | undefined) => {
    if (profile === undefined || profile.access_items === 0) {
      void change(id)
      return
    }
    pickConsequence(task.id, profile).then(setPick, (e: unknown) => toast.error(errorText(e)))
  }
  const dialog =
    pick === null ? null : (
      <PickCredentialDialog
        title={task.title}
        pick={pick}
        onPick={(reset) => void change(pick.profile.id, reset)}
        onClose={() => {
          setPick(null)
        }}
      />
    )
  return { choose, dialog }
}
