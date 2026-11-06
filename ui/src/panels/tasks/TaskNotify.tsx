import type { Task } from '@seti/shared'
import { Bell, BellOff } from 'lucide-react'
import { toast } from 'sonner'
import { apiPatch, errorText } from '@/api'
import { ToggleButton } from '@/components/ToggleButton'

/** Whether the agent's finished turns and needs-you states notify; muting covers every device. */
export function TaskNotify({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const on = !task.notifications_muted
  const save = async (notify: boolean) => {
    try {
      await apiPatch<Task>(`/tasks/${task.id}`, { notifications_muted: !notify })
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  return (
    <ToggleButton
      pressed={on}
      onPressedChange={(notify) => void save(notify)}
      icon={on ? Bell : BellOff}
      label="Notify"
      hint={
        on
          ? 'Its finished turns and failures notify you. Press to mute it on every device.'
          : 'Muted on every device: no push, toast or chime for it. Press to notify again.'
      }
    />
  )
}
