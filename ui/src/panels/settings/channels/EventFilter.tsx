import { channelKinds, normalizeEventKind, type ChannelInfo } from '@seti/shared'
import { Check, Filter } from 'lucide-react'
import { useState } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { filterLabel } from './subscriptions'

const parseKinds = (text: string) => [
  ...new Set(
    text
      .split(',')
      .map(normalizeEventKind)
      .filter((kind) => kind !== ''),
  ),
]

/** The kinds a sender reports, then the ones this channel has seen. */
function suggestions(info: ChannelInfo): string[] {
  const seen = info.recent.map((event) => event.kind).filter((kind) => kind !== '')
  return [...new Set([...channelKinds(info), ...seen])]
}

/** Picks the event kinds a subscriber takes, as a comma list with the known kinds to toggle. */
export function EventFilter({
  info,
  subscriber,
  events,
  onSave,
}: {
  info: ChannelInfo
  subscriber: string
  events: readonly string[] | null
  onSave: (events: string[] | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const chosen = parseKinds(text)
  const toggle = (kind: string) => {
    const next = chosen.includes(kind) ? chosen.filter((entry) => entry !== kind) : [...chosen, kind]
    setText(next.join(', '))
  }
  const save = () => {
    onSave(chosen.length === 0 ? null : chosen)
    setOpen(false)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setText((events ?? []).join(', '))
        }
      }}
    >
      <Hint text="Which event kinds reach this subscriber; a kind takes every kind under it">
        <PopoverTrigger asChild>
          <Button size="xs" variant="outline" aria-label={`${subscriber} event filter`}>
            <Filter />
            <span className="max-w-32 truncate">{filterLabel(events)}</span>
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" className="w-80 text-xs">
        <div className="mb-1 font-medium">Event kinds for {subscriber}</div>
        <Input
          aria-label="Event kinds"
          placeholder="All events"
          className="h-7 text-xs"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              save()
            }
          }}
        />
        <p className="mt-1 text-muted-foreground">Comma separated; empty takes every event.</p>
        {suggestions(info).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {suggestions(info).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={chosen.includes(kind)}
                onClick={() => {
                  toggle(kind)
                }}
                className={cn(
                  'border border-border px-1.5 py-0.5 font-mono text-2xs hover:bg-muted',
                  chosen.includes(kind) && 'border-primary bg-primary/10 text-primary',
                )}
              >
                {kind}
              </button>
            ))}
          </div>
        )}
        <div className="mt-2 flex justify-end">
          <Button size="xs" onClick={save}>
            <Check />
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
