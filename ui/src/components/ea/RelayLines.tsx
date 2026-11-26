import type { EaRelay } from '@seti/shared'
import { Forward, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'

function RelayLine({ relay }: { relay: EaRelay }) {
  const [shown, setShown] = useState(relay)
  const [busy, setBusy] = useState(false)
  const takeBack = async () => {
    setBusy(true)
    try {
      setShown(await apiPost<EaRelay>(`/ea/relays/${String(relay.id)}/take-back`, {}))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const told = shown.title === '' ? 'an agent' : shown.title
  return (
    <div className="flex min-h-8 items-center gap-2 border-t border-border px-2 py-1" data-testid="ea-relay">
      <Forward className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 break-words text-foreground">
        {shown.taken_back ? `Took back from ${told}` : `Told ${told}`}
      </span>
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

/** The relays the EA sent of an inbox item, each with Take back while its agent has not read it. */
export function RelayLines({ relays }: { relays: readonly EaRelay[] }) {
  return (
    <>
      {relays.map((relay) => (
        <RelayLine key={relay.id} relay={relay} />
      ))}
    </>
  )
}
