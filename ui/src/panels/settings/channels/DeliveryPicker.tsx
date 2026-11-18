import { DELIVERY_TIMINGS, type DeliveryTiming } from '@seti/shared'
import { Bot, FastForward, Hourglass, MessageSquare, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

type Choice = DeliveryTiming | 'agent'

const OPTIONS: Record<Choice, { label: string; icon: LucideIcon; hint: string }> = {
  agent: { label: 'Agent default', icon: Bot, hint: "Follows the agent's Updates setting." },
  now: {
    label: 'Now',
    icon: FastForward,
    hint: 'At once: an idle agent starts a turn, and a running turn takes it at its next step, uninterrupted.',
  },
  after_turn: {
    label: 'After turn',
    icon: Hourglass,
    hint: 'Once the running turn is over, in a turn of its own; an idle agent starts at once.',
  },
  with_message: {
    label: 'With message',
    icon: MessageSquare,
    hint: 'Held until you next message the agent or answer its question; it never starts a turn by itself.',
  },
}

const CHOICES: readonly Choice[] = ['agent', ...DELIVERY_TIMINGS]

const CEILING = "The agent's Updates setting caps this: Wait for my message holds every update, and Off drops them."

const choiceOf = (delivery: DeliveryTiming | null): Choice => delivery ?? 'agent'

/** A subscription's delivery as a small icon and label. */
export function DeliveryLabel({ delivery, className }: { delivery: DeliveryTiming | null; className?: string }) {
  const { label, icon: Icon } = OPTIONS[choiceOf(delivery)]
  return (
    <span className={cn('inline-flex items-center gap-1', className)} data-delivery={choiceOf(delivery)}>
      <Icon className="size-3 shrink-0" aria-hidden />
      {label}
    </span>
  )
}

/** Picks when a subscribed agent gets a channel's updates; compact shows the icon alone. */
export function DeliveryPicker({
  subscriber,
  delivery,
  compact = false,
  disabled = false,
  onSave,
}: {
  /** Who the choice is for, in the control's name: the agent's title or the channel's name. */
  subscriber: string
  delivery: DeliveryTiming | null
  compact?: boolean
  disabled?: boolean
  onSave: (delivery: DeliveryTiming | null) => void
}) {
  const [open, setOpen] = useState(false)
  const current = choiceOf(delivery)
  const { label, icon: Icon, hint } = OPTIONS[current]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint text={`${label}. ${hint} ${CEILING}`}>
        <PopoverTrigger asChild>
          <Button
            size={compact ? 'icon-xs' : 'xs'}
            variant={compact ? 'ghost' : 'outline'}
            className={cn(compact && 'size-4')}
            disabled={disabled}
            aria-label={`${subscriber} delivery: ${label}`}
            data-delivery={current}
          >
            <Icon />
            {!compact && label}
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" className="w-72 p-1 text-xs">
        <ul aria-label={`Delivery for ${subscriber}`}>
          {CHOICES.map((choice) => {
            const option = OPTIONS[choice]
            return (
              <li key={choice}>
                <button
                  type="button"
                  aria-pressed={choice === current}
                  className={cn(
                    'flex min-h-11 w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-muted',
                    choice === current && 'bg-primary/10',
                  )}
                  onClick={() => {
                    setOpen(false)
                    if (choice !== current) {
                      onSave(choice === 'agent' ? null : choice)
                    }
                  }}
                >
                  <option.icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0">
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-muted-foreground">{option.hint}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <p className="border-t border-border px-2 py-1.5 text-muted-foreground">{CEILING}</p>
      </PopoverContent>
    </Popover>
  )
}
