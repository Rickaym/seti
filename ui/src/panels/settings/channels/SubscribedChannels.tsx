import type { ChannelInfo, ChannelSubscribeInput, ChannelSubscription } from '@seti/shared'
import { AlarmClock, Plus, Radar, Webhook, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { SettingsLink } from '@/components/SettingsLink'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { filterLabel } from './subscriptions'

const SOURCE_ICONS = { poller: Radar, reminder: AlarmClock } as const

function SourceIcon({ preset }: { preset: string }) {
  const Icon = preset === 'poller' || preset === 'reminder' ? SOURCE_ICONS[preset] : Webhook
  return <Icon className="size-3 shrink-0 text-muted-foreground" />
}

function AddChannel({
  taken,
  hint,
  onAdd,
}: {
  taken: ReadonlySet<string>
  hint: string
  onAdd: (channel: ChannelInfo) => void
}) {
  const [open, setOpen] = useState(false)
  const [channels, setChannels] = useState<ChannelInfo[] | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    let current = true
    apiGet<ChannelInfo[]>('/channels')
      .then((list) => {
        if (current) {
          setChannels(list)
        }
      })
      .catch((e: unknown) => toast.error(errorText(e)))
    return () => {
      current = false
    }
  }, [open])

  const offered = (channels ?? []).filter((channel) => !taken.has(channel.id))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint text={hint}>
        <PopoverTrigger asChild>
          <Button size="icon-xs" variant="ghost" aria-label="Add channel">
            <Plus />
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="start" className="max-h-72 w-64 overflow-y-auto p-1 text-xs">
        {channels === null && <p className="p-2 text-muted-foreground">Loading...</p>}
        {channels !== null && offered.length === 0 && (
          <p className="p-2 text-muted-foreground">
            No other channel; add one in <SettingsLink page="channels">Settings, Channels</SettingsLink>.
          </p>
        )}
        {offered.length > 0 && (
          <ul aria-label="Channels to subscribe">
            {offered.map((channel) => (
              <li key={channel.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => {
                    setOpen(false)
                    onAdd(channel)
                  }}
                >
                  <SourceIcon preset={channel.preset} />
                  <span className="truncate">{channel.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}

interface SubscribedChannelsProps {
  /** Where the subscriber's subscriptions are listed, such as `/ea/channels`. */
  listPath: string
  subscriber: ChannelSubscribeInput
  addHint: string
  testId: string
  onCount?: (count: number) => void
}

/** The channels one subscriber, an agent or the EA, takes events from, each removable. */
export function SubscribedChannels({ listPath, subscriber, addHint, testId, onCount }: SubscribedChannelsProps) {
  const [subs, setSubs] = useState<ChannelSubscription[] | null>(null)

  useEffect(() => {
    let current = true
    apiGet<ChannelSubscription[]>(listPath)
      .then((found) => {
        if (current) {
          setSubs(found)
        }
      })
      .catch((e: unknown) => toast.error(errorText(e)))
    return () => {
      current = false
    }
  }, [listPath])

  useEffect(() => {
    onCount?.(subs?.length ?? 0)
  }, [subs, onCount])

  if (subs === null) {
    return <span className="text-muted-foreground">Loading...</span>
  }
  const add = async (channel: ChannelInfo) => {
    try {
      const added = await apiPost<ChannelSubscription>(`/channels/${channel.id}/subscriptions`, subscriber)
      setSubs([...subs, added])
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  const remove = async (sub: ChannelSubscription) => {
    try {
      await apiDelete(`/channels/${sub.channel_id}/subscriptions/${String(sub.id)}`)
      setSubs(subs.filter((entry) => entry.id !== sub.id))
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid={testId}>
      {subs.length === 0 && <span className="text-muted-foreground">None</span>}
      {subs.map((sub) => (
        <span key={sub.id} className="flex items-center gap-1 border border-border py-0.5 pl-1.5">
          <SourceIcon preset={sub.preset} />
          <span className="max-w-40 truncate" title={filterLabel(sub.events)}>
            {sub.channel_name}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-4"
            aria-label={`Unsubscribe from ${sub.channel_name}`}
            onClick={() => void remove(sub)}
          >
            <X />
          </Button>
        </span>
      ))}
      <AddChannel
        taken={new Set(subs.map((sub) => sub.channel_id))}
        hint={addHint}
        onAdd={(channel) => void add(channel)}
      />
    </div>
  )
}
