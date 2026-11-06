import {
  SETI_CONTROL_HINTS,
  SETI_CONTROL_LABELS,
  SETI_CONTROL_LEVELS,
  type SetiControlLevel,
  type Task,
} from '@seti/shared'
import { CircleOff, Joystick, UserRound, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPatch, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export const SETI_CONTROL_ICONS: Record<SetiControlLevel, LucideIcon> = {
  off: CircleOff,
  self: UserRound,
  full: Joystick,
}

/** Off is least privilege, so it reads muted when chosen; Self and Full read as chosen. */
const PRESSED: Record<SetiControlLevel, string> = {
  off: 'aria-pressed:border-border aria-pressed:bg-muted aria-pressed:text-foreground',
  self: 'aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary',
  full: 'aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary',
}

/** The agent's Seti control level; only the user changes it, and it applies next turn. */
export function SetiControlRow({
  task,
  level,
  onSaved,
}: {
  task: Task
  level: SetiControlLevel
  onSaved: (level: SetiControlLevel) => void
}) {
  const [busy, setBusy] = useState(false)
  const save = async (next: SetiControlLevel) => {
    setBusy(true)
    try {
      await apiPatch<Task>(`/tasks/${task.id}`, { seti_control: next })
      onSaved(next)
      toast.success('Applies from the next turn')
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      aria-label="Seti control"
      className="flex min-w-0 flex-wrap items-center gap-2 border border-input px-2.5 py-1.5 text-xs"
    >
      <Joystick className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Seti control</div>
        <div className="text-2xs text-muted-foreground">{SETI_CONTROL_HINTS[level]}</div>
      </div>
      <div role="group" aria-label="Seti control level" className="flex shrink-0 gap-1">
        {SETI_CONTROL_LEVELS.map((choice) => {
          const Icon = SETI_CONTROL_ICONS[choice]
          return (
            <Hint key={choice} text={SETI_CONTROL_HINTS[choice]}>
              <Button
                size="sm"
                variant="outline"
                aria-pressed={level === choice}
                disabled={busy}
                className={cn('pointer-coarse:h-10', PRESSED[choice])}
                onClick={() => {
                  if (choice !== level) {
                    void save(choice)
                  }
                }}
              >
                <Icon aria-hidden />
                {SETI_CONTROL_LABELS[choice]}
              </Button>
            </Hint>
          )
        })}
      </div>
    </section>
  )
}
