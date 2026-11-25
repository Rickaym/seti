import { Hint } from '@/components/Hint'
import { cn } from '@/lib/utils'

/** Whether a setting is this agent's own choice or comes from elsewhere, named by `label`. */
export function SourceMark({ custom, hint, label }: { custom: boolean; hint: string; label?: string }) {
  return (
    <Hint text={hint}>
      <span
        className={cn(
          'shrink-0 border px-1 text-2xs',
          custom ? 'border-primary/40 bg-primary/10 text-primary' : 'border-transparent text-muted-foreground',
        )}
      >
        {label ?? (custom ? 'Custom' : 'Inherited')}
      </span>
    </Hint>
  )
}
