import type { ChannelInfo, ChannelSecret, PollerChannelInfo, ReminderChannelInfo } from '@seti/shared'
import { AlarmClock, Plus, Radar, Webhook } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiGet, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { NewWebhookDialog } from './channels/NewWebhookDialog'
import { PollerCard } from './channels/PollerCard'
import { PollerEditor } from './channels/PollerEditor'
import { ReminderCard } from './channels/ReminderCard'
import { ReminderEditor } from './channels/ReminderEditor'
import { SecretDialog } from './channels/SecretDialog'
import { WebhookCard } from './channels/WebhookCard'
import { SettingsBody, SettingsHeader } from './layout'

const SOURCES = [
  {
    id: 'webhook',
    label: 'Webhook',
    icon: Webhook,
    description: 'A sender posts events to a signed URL, such as GitHub, Sentry or a monitor.',
  },
  {
    id: 'poller',
    label: 'Poller',
    icon: Radar,
    description: 'Seti runs a small script on a schedule for services without webhooks, such as feeds and APIs.',
  },
  {
    id: 'reminder',
    label: 'Reminder',
    icon: AlarmClock,
    description: 'Seti runs a script on an interval and hands its message to the subscribers, such as a nudge.',
  },
] as const

type Source = (typeof SOURCES)[number]['id']

function NewChannel({ onPick }: { onPick: (source: Source) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm">
          <Plus />
          New
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1 text-xs">
        <ul aria-label="Channel sources">
          {SOURCES.map(({ id, label, icon: Icon, description }) => (
            <li key={id}>
              <button
                type="button"
                className="flex w-full items-start gap-2 px-2 py-2 text-left hover:bg-muted"
                onClick={() => {
                  setOpen(false)
                  onPick(id)
                }}
              >
                <Icon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <span className="block font-medium">{label}</span>
                  <span className="block text-muted-foreground">{description}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

/** Channels: webhooks, pollers and reminders, whose events go to their subscribers. */
export function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelInfo[] | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState<Source | null>(null)
  const [editing, setEditing] = useState<PollerChannelInfo | null>(null)
  const [editingReminder, setEditingReminder] = useState<ReminderChannelInfo | null>(null)
  const [secret, setSecret] = useState<ChannelSecret | null>(null)
  useEffect(() => {
    apiGet<ChannelInfo[]>('/channels').then(setChannels, (e: unknown) => {
      setError(errorText(e))
    })
  }, [])
  const replace = (next: ChannelInfo) => {
    setChannels((prev) => prev?.map((info) => (info.id === next.id ? next : info)) ?? null)
  }
  const removed = (id: string) => {
    setChannels((prev) => prev?.filter((info) => info.id !== id) ?? null)
  }
  const created = (next: ChannelSecret) => {
    setCreating(null)
    setChannels((prev) => [...(prev ?? []), next.channel])
    setSecret(next)
  }
  const pollerSaved = (next: ChannelInfo) => {
    if (editing === null) {
      setChannels((prev) => [...(prev ?? []), next])
    } else {
      replace(next)
    }
    setCreating(null)
    setEditing(null)
  }
  const reminderSaved = (next: ChannelInfo) => {
    if (editingReminder === null) {
      setChannels((prev) => [...(prev ?? []), next])
    } else {
      replace(next)
    }
    setCreating(null)
    setEditingReminder(null)
  }
  const card = (info: ChannelInfo) => {
    if (info.source === 'poller') {
      return (
        <PollerCard
          key={info.id}
          info={info}
          onChange={replace}
          onRemoved={removed}
          onEdit={() => {
            setEditing(info)
          }}
        />
      )
    }
    if (info.source === 'reminder') {
      return (
        <ReminderCard
          key={info.id}
          info={info}
          onChange={replace}
          onRemoved={removed}
          onEdit={() => {
            setEditingReminder(info)
          }}
        />
      )
    }
    return <WebhookCard key={info.id} info={info} onChange={replace} onRemoved={removed} onSecret={setSecret} />
  }
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="Channels"
          description="Webhooks senders post to, pollers for services without them, and reminders Seti runs on an interval; the EA and agents subscribe."
          actions={<NewChannel onPick={setCreating} />}
        />
      }
    >
      {channels === null && (
        <p className={error === '' ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
          {error === '' ? 'Loading...' : error}
        </p>
      )}
      {channels?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No channels yet. Create a webhook and point a sender at its URL, a poller for a feed or API, or a reminder.
        </p>
      )}
      <div className="space-y-4">{channels?.map(card)}</div>
      <NewWebhookDialog
        open={creating === 'webhook'}
        onClose={() => {
          setCreating(null)
        }}
        onCreated={created}
      />
      {(creating === 'poller' || editing !== null) && (
        <PollerEditor
          key={editing?.id ?? 'new'}
          open
          editing={editing}
          onClose={() => {
            setCreating(null)
            setEditing(null)
          }}
          onSaved={pollerSaved}
        />
      )}
      {(creating === 'reminder' || editingReminder !== null) && (
        <ReminderEditor
          key={editingReminder?.id ?? 'new'}
          editing={editingReminder}
          onClose={() => {
            setCreating(null)
            setEditingReminder(null)
          }}
          onSaved={reminderSaved}
        />
      )}
      <SecretDialog
        created={secret}
        onClose={() => {
          setSecret(null)
        }}
      />
    </SettingsBody>
  )
}
