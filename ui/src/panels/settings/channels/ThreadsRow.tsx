import type { ChannelInfo, WebhookChannelInfo, WebhookThreads } from '@seti/shared'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '../layout'

const MESSAGE_EVENTS = 'message.channels, message.groups, message.im and message.mpim'

function Summary({ threads }: { threads: WebhookThreads }) {
  return (
    <>
      Replies in Slack threads an agent posted in reach that agent; DM replies also hands it the next messages in a
      direct message it wrote in, for 24 hours.
      {threads.message_seen_at === null && (
        <span className="mt-1 block text-muted-foreground" data-testid="no-message-events">
          No message events yet: subscribe to {MESSAGE_EVENTS} in your Slack app.
        </span>
      )}
    </>
  )
}

/** A Slack webhook's two switches: thread replies and DM replies, both the user's alone. */
export function ThreadsRow({ info, onChange }: { info: WebhookChannelInfo; onChange: (next: ChannelInfo) => void }) {
  const [busy, setBusy] = useState(false)
  const { threads } = info
  if (threads === null) {
    return null
  }
  const set = async (change: { replies?: boolean; dms?: boolean }) => {
    setBusy(true)
    try {
      onChange(await apiPut<WebhookChannelInfo>(`/channels/${info.id}/threads`, change))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingRow label="Replies" stack description={<Summary threads={threads} />}>
      <Hint text="Replies in threads agents posted in reach those agents">
        <span className="flex min-h-11 items-center gap-2 text-xs">
          <Switch
            aria-label={`${info.name} thread replies`}
            checked={threads.replies}
            disabled={busy}
            onCheckedChange={(replies) => void set({ replies })}
          />
          Threads
        </span>
      </Hint>
      <Hint text="After an agent writes in a direct message, the next messages there reach it for 24 hours">
        <span className="flex min-h-11 items-center gap-2 text-xs">
          <Switch
            aria-label={`${info.name} DM replies`}
            checked={threads.dms}
            disabled={busy}
            onCheckedChange={(dms) => void set({ dms })}
          />
          DMs
        </span>
      </Hint>
    </SettingRow>
  )
}
