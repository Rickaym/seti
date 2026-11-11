import type { UiModApi } from '@seti/mod-api'
import { Eraser, LoaderCircle, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { SideChats } from './chat-store'

/** Deleting asides, from the transcript or the dock; Seti audits each deletion. */
export function asideActions(api: UiModApi, chats: SideChats) {
  const { Button, Dialog, Hint } = api.kit

  /** Deletes one aside at once; it is only a side question, and the agent never saw it. */
  function DeleteButton({ agent, id }: { agent: string; id: string }) {
    const [busy, setBusy] = useState(false)
    const remove = async () => {
      setBusy(true)
      try {
        await chats.remove(agent, id)
      } catch (e) {
        setBusy(false)
        api.kit.fail('Could not delete the aside', api.kit.errorText(e))
      }
    }
    return (
      <Hint text="Delete this aside for good; the agent never saw it">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Delete aside"
          disabled={busy}
          className="pointer-coarse:size-11"
          onClick={() => void remove()}
        >
          {busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
        </Button>
      </Hint>
    )
  }

  /** Deletes every aside of the agent, after the user says yes. */
  function ClearButton({ agent, title, count }: { agent: string; title: string; count: number }) {
    const [asking, setAsking] = useState(false)
    const [busy, setBusy] = useState(false)
    const clear = async () => {
      setBusy(true)
      try {
        await chats.clear(agent)
        setAsking(false)
      } catch (e) {
        api.kit.fail('Could not clear the asides', api.kit.errorText(e))
      } finally {
        setBusy(false)
      }
    }
    return (
      <>
        <Hint text={`Delete every aside of ${title}, whoever asked it`}>
          <Button
            variant="ghost"
            size="xs"
            disabled={count === 0}
            onClick={() => {
              setAsking(true)
            }}
          >
            <Eraser />
            Clear
          </Button>
        </Hint>
        <Dialog open={asking} onOpenChange={setAsking} title="Clear asides">
          <p className="text-sm">
            Delete all {count} {count === 1 ? 'aside' : 'asides'} of {title}? They are gone for good; the agent never
            saw them.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setAsking(false)
              }}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void clear()}>
              <Eraser />
              Clear all
            </Button>
          </div>
        </Dialog>
      </>
    )
  }

  return { DeleteButton, ClearButton }
}
