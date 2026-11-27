import type { EaRelay } from '@seti/shared'
import { Square, Undo2, UserRoundCheck } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'

function lineText(relay: EaRelay, told: string, stopped: boolean): string {
  if (relay.taken_back) {
    return `Took back from ${told}`
  }
  if (relay.started) {
    return stopped ? `Started and stopped ${told}` : `Started ${told}`
  }
  return `Assigned ${told}`
}

function RelayLine({ relay }: { relay: EaRelay }) {
  const [shown, setShown] = useState(relay)
  const [busy, setBusy] = useState(false)
  const [stopped, setStopped] = useState(false)
  const act = async (run: () => Promise<void>) => {
    setBusy(true)
    try {
      await run()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const takeBack = async () =>
    act(async () => {
      setShown(await apiPost<EaRelay>(`/ea/relays/${String(relay.id)}/take-back`, {}))
    })
  const stop = async (taskId: string) =>
    act(async () => {
      await apiPost(`/tasks/${taskId}/stop`)
      setStopped(true)
    })
  const told = shown.title === '' ? 'an agent' : shown.title
  return (
    <div className="flex min-h-8 items-center gap-2 border-t border-border px-2 py-1" data-testid="ea-relay">
      <UserRoundCheck className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 break-words text-foreground">{lineText(shown, told, stopped)}</span>
      {shown.started && shown.task_id !== null && !stopped && (
        <Hint text={`Stop ${told}'s turn; it keeps its transcript`}>
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => void stop(shown.task_id ?? '')}
            className="pointer-coarse:h-11"
          >
            <Square aria-hidden="true" />
            Stop
          </Button>
        </Hint>
      )}
      {shown.pending && !shown.taken_back && (
        <Hint text={`Take the message back before ${told} reads it`}>
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => void takeBack()}
            className="pointer-coarse:h-11"
          >
            <Undo2 aria-hidden="true" />
            Take back
          </Button>
        </Hint>
      )}
    </div>
  )
}

/** What the EA assigned of an inbox item: Take back while unread, Stop for an agent it started. */
export function RelayLines({ relays }: { relays: readonly EaRelay[] }) {
  return (
    <>
      {relays.map((relay) => (
        <RelayLine key={relay.id} relay={relay} />
      ))}
    </>
  )
}
