import type {
  ChannelEaMode,
  ChannelInfo,
  ChannelRoute,
  ChannelSubscribeInput,
  ChannelSubscription,
  TaskListEntry,
} from '@seti/shared'
import { Bot, Pin, Plus, X, Zap } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiPost, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useTasks } from '@/hooks/useTasks'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { EventFilter } from './EventFilter'
import { ROUTE_TONE } from './subscriptions'

const sameTarget = (route: ChannelRoute, sub: ChannelSubscription) =>
  route.target === sub.target && route.task_id === sub.task_id

/** What became of the newest event this subscriber was offered. */
function LastRoute({ info, sub }: { info: ChannelInfo; sub: ChannelSubscription }) {
  for (const delivery of info.deliveries) {
    const route = delivery.routes.find((entry) => sameTarget(entry, sub))
    if (route !== undefined) {
      return (
        <Hint text={route.reason}>
          <span className="text-muted-foreground" data-testid="subscriber-last">
            <span className={cn('font-semibold', ROUTE_TONE[route.outcome])}>{route.outcome}</span>{' '}
            {relativeTime(delivery.received_at)}
          </span>
        </Hint>
      )
    }
  }
  return <span className="text-muted-foreground">Nothing yet</span>
}

/** The agents to offer, pinned long-running ones first; those already subscribed are left out. */
function candidates(tasks: readonly TaskListEntry[], subs: readonly ChannelSubscription[]): TaskListEntry[] {
  const taken = new Set(subs.map((sub) => sub.task_id))
  const open = tasks.filter((task) => !taken.has(task.id))
  return [...open.filter((task) => task.pinned), ...open.filter((task) => !task.pinned)]
}

function AddAgent({ subs, onAdd }: { subs: readonly ChannelSubscription[]; onAdd: (taskId: string) => void }) {
  const [open, setOpen] = useState(false)
  const { tasks } = useTasks()
  const offered = candidates(tasks, subs)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint text="Send this channel's events to an agent as updates, as its PR updates arrive">
        <PopoverTrigger asChild>
          <Button size="xs" variant="outline">
            <Plus />
            Agent
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" className="max-h-80 w-72 overflow-y-auto p-1 text-xs">
        {offered.length === 0 ? (
          <p className="p-2 text-muted-foreground">No other agent to add.</p>
        ) : (
          <ul aria-label="Agents to subscribe">
            {offered.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => {
                    setOpen(false)
                    onAdd(task.id)
                  }}
                >
                  {task.pinned ? (
                    <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
                  ) : (
                    <Bot className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{task.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">{label}</div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </li>
  )
}

/** Who the channel's events go to: the EA and agents, each with its filter and latest outcome. */
export function Subscribers({ info, onChange }: { info: ChannelInfo; onChange: (next: ChannelInfo) => void }) {
  const [busy, setBusy] = useState(false)
  const subs = info.subscriptions
  const ea = subs.find((sub) => sub.target === 'ea')
  const agents = subs.filter((sub) => sub.target === 'task')
  const base = `/channels/${info.id}/subscriptions`

  const run = async (work: () => Promise<ChannelSubscription[]>) => {
    setBusy(true)
    try {
      onChange({ ...info, subscriptions: await work() })
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const subscribe = (input: ChannelSubscribeInput) =>
    void run(async () => [...subs, await apiPost<ChannelSubscription>(base, input)])
  const unsubscribe = (sub: ChannelSubscription) =>
    void run(async () => {
      await apiDelete(`${base}/${String(sub.id)}`)
      return subs.filter((entry) => entry.id !== sub.id)
    })
  const save = (sub: ChannelSubscription, path: string, body: unknown) =>
    void run(async () => {
      const saved = await apiPut<ChannelSubscription>(`${base}/${String(sub.id)}${path}`, body)
      return subs.map((entry) => (entry.id === saved.id ? saved : entry))
    })
  const setFilter = (sub: ChannelSubscription, events: string[] | null) => {
    save(sub, '', { events })
  }
  const setMode = (sub: ChannelSubscription, mode: ChannelEaMode) => {
    save(sub, '/mode', { mode })
  }

  return (
    <div className="border-b border-border">
      <div className="flex items-center justify-between gap-3 px-3 pt-2">
        <div className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Delivered to</div>
        <AddAgent
          subs={subs}
          onAdd={(taskId) => {
            subscribe({ target: 'task', task_id: taskId })
          }}
        />
      </div>
      <ul aria-label={`${info.name} subscribers`}>
        <Row
          label={
            <div>
              <div className="font-medium">EA</div>
              <div className="text-muted-foreground">
                {ea === undefined ? 'Off; events stay on this page' : <LastRoute info={info} sub={ea} />}
              </div>
            </div>
          }
        >
          {ea !== undefined && (
            <>
              <EventFilter
                info={info}
                subscriber="EA"
                events={ea.events}
                onSave={(events) => {
                  setFilter(ea, events)
                }}
              />
              <ToggleButton
                size="xs"
                icon={Zap}
                label="Auto act"
                hint="On: the EA sends an alert's work to an existing agent without asking. Off: it reports and asks first."
                pressed={ea.mode === 'act'}
                disabled={busy}
                onPressedChange={(on) => {
                  setMode(ea, on ? 'act' : 'report')
                }}
              />
            </>
          )}
          <Switch
            aria-label={`${info.name} EA delivery`}
            checked={ea !== undefined}
            disabled={busy}
            onCheckedChange={(on) => {
              if (on) {
                subscribe({ target: 'ea' })
              } else if (ea !== undefined) {
                unsubscribe(ea)
              }
            }}
          />
        </Row>
        {agents.map((sub) => (
          <Row
            key={sub.id}
            label={
              <div>
                <div className="truncate font-medium">
                  {sub.task_title}
                  {sub.task_archived && <span className="font-normal text-muted-foreground"> (archived)</span>}
                </div>
                <div className="text-muted-foreground">
                  <LastRoute info={info} sub={sub} />
                </div>
              </div>
            }
          >
            <EventFilter
              info={info}
              subscriber={sub.task_title ?? 'agent'}
              events={sub.events}
              onSave={(events) => {
                setFilter(sub, events)
              }}
            />
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={busy}
              aria-label={`Unsubscribe ${sub.task_title ?? 'agent'}`}
              onClick={() => {
                unsubscribe(sub)
              }}
            >
              <X />
            </Button>
          </Row>
        ))}
      </ul>
    </div>
  )
}
