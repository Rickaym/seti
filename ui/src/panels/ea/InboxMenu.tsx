import type { EaFollowup, EaWatch } from '@seti/shared'
import { AlarmClock, BellRing, Eye, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface Scheduled {
  followups: EaFollowup[]
  watches: EaWatch[]
}

const EMPTY: Scheduled = { followups: [], watches: [] }

async function load(): Promise<Scheduled> {
  const [followups, watches] = await Promise.all([
    apiGet<EaFollowup[]>('/ea/followups'),
    apiGet<EaWatch[]>('/ea/watches'),
  ])
  return { followups, watches }
}

function Heading({ children }: { children: string }) {
  return <div className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">{children}</div>
}

function Line({
  icon,
  text,
  detail,
  remove,
  onRemove,
}: {
  icon: ReactNode
  text: string
  detail: string
  remove: string
  onRemove: () => void
}) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="break-words">{text}</div>
        <div className="text-muted-foreground">{detail}</div>
      </div>
      <Button variant="ghost" size="icon-xs" aria-label={remove} title={remove} onClick={onRemove}>
        <X />
      </Button>
    </li>
  )
}

/** Follow-ups and reminders the EA has scheduled and the tasks it watches, each removable. */
export function InboxMenu() {
  const [open, setOpen] = useState(false)
  const [scheduled, setScheduled] = useState<Scheduled>(EMPTY)
  const failed = (e: unknown) => {
    toast.error(errorText(e))
  }
  useEffect(() => {
    load().then(setScheduled, failed)
  }, [open])

  const remove = async (path: string) => {
    try {
      await apiDelete(path)
    } catch (e) {
      toast.error(errorText(e))
    }
    await load().then(setScheduled, failed)
  }

  const count = scheduled.followups.length + scheduled.watches.length
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint text="What the EA has scheduled and the agents it watches">
        <PopoverTrigger asChild>
          <Button size="xs" variant="ghost" aria-label="Watch: scheduled and watched" className="text-muted-foreground">
            <AlarmClock className="size-4" />
            Watch
            {count > 0 && <span className="tabular-nums">{count}</span>}
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" className="w-80">
        <Heading>Scheduled</Heading>
        {scheduled.followups.length === 0 ? (
          <p className="text-muted-foreground">No follow-ups or reminders.</p>
        ) : (
          <ul className="space-y-2" aria-label="Scheduled">
            {scheduled.followups.map((item) => (
              <Line
                key={item.id}
                icon={
                  item.kind === 'reminder' ? <BellRing className="size-3.5" /> : <AlarmClock className="size-3.5" />
                }
                text={item.title}
                detail={`${item.kind === 'reminder' ? 'Reminder' : 'Follow-up'}, ${item.local_due}`}
                remove={`Cancel ${item.title}`}
                onRemove={() => void remove(`/ea/followups/${String(item.id)}`)}
              />
            ))}
          </ul>
        )}
        <Heading>Watching</Heading>
        {scheduled.watches.length === 0 ? (
          <p className="text-muted-foreground">No agents.</p>
        ) : (
          <ul className="space-y-2" aria-label="Watching">
            {scheduled.watches.map((watch) => (
              <Line
                key={watch.id}
                icon={<Eye className="size-3.5" />}
                text={watch.task_title}
                detail={watch.note === '' ? 'Turn ends, errors, PR and CI changes' : watch.note}
                remove={`Stop watching ${watch.task_title}`}
                onRemove={() => void remove(`/ea/watches/${encodeURIComponent(watch.task_id)}`)}
              />
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
