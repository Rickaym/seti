import { RUNTIME_NAMES, type RestartSessionInput, type Task } from '@seti/shared'
import { ArrowRightLeft } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { useConfirm } from '@/components/ui/confirm-context'
import { NativeSelectOptGroup, NativeSelectOption } from '@/components/ui/native-select'
import { useRuntimes } from '@/hooks/useRuntimes'
import { modelGroups, pickOf, type RuntimePick } from '@/lib/runtime-pick'
import { IconSelect } from '@/panels/tasks/ModelPicker'

const CHOOSE = ''

const HINT =
  'Moves this agent to another runtime: a new session in the same folders, with a brief of its work. ' +
  'Its conversation, links and cost stay; moving back resumes its earlier session there.'

function question(task: Task, pick: RuntimePick, running: boolean) {
  const name = RUNTIME_NAMES[pick.runtime]
  const parts = [
    `"${task.title}" starts a new ${name} session in the same folders, with ${pick.model ?? 'its default model'}, and gets a brief of its work with its next message.`,
    'Background shells, processes and subagents end, and so does Bypass.',
    running ? 'It is working now, so its turn stops first.' : '',
  ]
  return {
    title: `Continue on ${name}`,
    message: 'The conversation stays here.',
    detail: parts.filter((part) => part !== '').join(' '),
    confirmLabel: running ? 'Stop and move' : 'Move',
    icon: ArrowRightLeft,
  }
}

/** Moves the agent to another runtime the user has on, after a confirmation; hidden when none is. */
export function ContinueOn({ task, running, onChanged }: { task: Task; running: boolean; onChanged: () => void }) {
  const offers = (useRuntimes().data?.offers ?? []).filter((offer) => offer.runtime !== task.runtime)
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const groups = modelGroups(offers)
  if (groups.length === 0) {
    return null
  }
  const move = async (value: string) => {
    const pick = pickOf(value, offers)
    if (pick === null || !(await confirm(question(task, pick, running)))) {
      return
    }
    setBusy(true)
    try {
      const body: RestartSessionInput = {
        interrupt: running,
        runtime: pick.runtime,
        ...(pick.model === null ? {} : { model: pick.model }),
      }
      await apiPost(`/tasks/${task.id}/session/restart`, body)
      toast.success(`Continues on ${RUNTIME_NAMES[pick.runtime]}`)
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid content-start gap-1" data-testid="continue-on">
      <IconSelect
        icon={ArrowRightLeft}
        label="Continue on"
        hint={HINT}
        value={CHOOSE}
        disabled={busy}
        onChange={(value) => {
          void move(value)
        }}
      >
        <NativeSelectOption value={CHOOSE}>Continue on</NativeSelectOption>
        {groups.map((group) => (
          <NativeSelectOptGroup key={group.runtime} label={group.label}>
            {group.options.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelectOptGroup>
        ))}
      </IconSelect>
      <p className="text-2xs text-muted-foreground">Another runtime, with a brief of the work</p>
    </div>
  )
}
