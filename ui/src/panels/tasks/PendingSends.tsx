import { CircleSlash, Pencil, RotateCw, Trash2 } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { RETRYING_LABEL } from '@/hooks/useClientSend'
import type { PendingSend, PendingStore } from '@/lib/pending-sends'
import { cn } from '@/lib/utils'
import { PendingText } from '@/panels/tasks/AttachmentChips'

const ACTION = 'pointer-coarse:min-h-11 pointer-coarse:px-3'

/** Why a message did not go out, with Retry, Edit and Delete; muted, since the agent is fine. */
function FailedNote({ send, store }: { send: PendingSend; store: PendingStore }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
      <CircleSlash className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0">Not sent{send.error === null ? '' : `: ${send.error}`}</span>
      <Hint text="Send it again">
        <Button
          variant="ghost"
          size="xs"
          className={ACTION}
          onClick={() => {
            store.retry(send.clientId)
          }}
        >
          <RotateCw />
          Retry
        </Button>
      </Hint>
      <Hint text="Move it back into the reply box">
        <Button
          variant="ghost"
          size="xs"
          className={ACTION}
          onClick={() => {
            store.edit(send.clientId)
          }}
        >
          <Pencil />
          Edit
        </Button>
      </Hint>
      <Hint text="Drop this message without sending it">
        <Button
          variant="ghost"
          size="xs"
          className={ACTION}
          onClick={() => {
            store.discard(send.clientId)
          }}
        >
          <Trash2 />
          Delete
        </Button>
      </Hint>
    </div>
  )
}

/** Floats in the message's corner, so the row keeps its height when its stored row replaces it. */
function SendingLabel({ state }: { state: PendingSend['state'] }) {
  if (state !== 'sending' && state !== 'retrying') {
    return null
  }
  return (
    <span className="float-right ml-3 text-2xs text-muted-foreground" data-sending-label="">
      {state === 'retrying' ? RETRYING_LABEL : 'Sending...'}
    </span>
  )
}

/** A message the server has not confirmed, shown faded where its row will land. */
function PendingRow({ send, store }: { send: PendingSend; store: PendingStore }) {
  return (
    <div className="space-y-1" data-pending-send={send.clientId} data-state={send.state}>
      <div
        className={cn(
          'border border-primary/30 bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap',
          send.state !== 'sent' && 'opacity-60',
          send.state === 'failed' && 'border-dashed',
        )}
      >
        <SendingLabel state={send.state} />
        <PendingText text={send.prompt} files={send.files} />
      </div>
      {send.state === 'failed' && <FailedNote send={send} store={store} />}
    </div>
  )
}

/** The reply box's messages that have no transcript row yet, in the order they were sent. */
export function PendingSends({ sends, store }: { sends: readonly PendingSend[]; store: PendingStore }) {
  if (sends.length === 0) {
    return null
  }
  return (
    <div className="space-y-3">
      {sends.map((send) => (
        <PendingRow key={send.clientId} send={send} store={store} />
      ))}
    </div>
  )
}
