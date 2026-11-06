import type { MessageRow } from '@seti/shared'
import { X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { InfoTip } from '@/components/InfoTip'

export type PromptRow = Extract<MessageRow, { kind: 'prompt' }>

/** Takes a queued message back before the agent reads it. */
function RemoveQueued({ taskId, rowId }: { taskId: string; rowId: number }) {
  const [removing, setRemoving] = useState(false)
  const remove = async () => {
    setRemoving(true)
    try {
      await apiDelete(`/tasks/${taskId}/queue/${String(rowId)}`)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setRemoving(false)
    }
  }
  return (
    <Hint text="Take it back before the agent reads it">
      <button
        type="button"
        className="hover:text-foreground disabled:opacity-50"
        aria-label="Remove queued message"
        disabled={removing}
        onClick={() => void remove()}
      >
        <X className="size-3" />
      </button>
    </Hint>
  )
}

/** Says a message sent during a turn waits for the agent, or was taken back before it read it. */
export function QueueNote({ taskId, row }: { taskId: string; row: PromptRow }) {
  const { queued, auto } = row.payload
  if (queued === 'waiting') {
    return (
      <div className="flex items-center gap-2 text-2xs text-muted-foreground">
        <InfoTip
          text={
            auto === true
              ? 'The agent gets them when this turn ends.'
              : 'The agent reads it at its next step, or at once if you stop the turn.'
          }
        >
          <span className="bg-queued/25 px-1 font-mono text-2xs font-semibold text-foreground uppercase">queued</span>
        </InfoTip>
        <RemoveQueued taskId={taskId} rowId={row.id} />
      </div>
    )
  }
  if (queued === 'removed') {
    return <div className="text-2xs text-muted-foreground">Taken back, not sent</div>
  }
  return null
}
