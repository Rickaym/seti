import { Hint } from '@/components/Hint'
import { cn } from '@/lib/utils'

/** Whether a setting is inherited from what every agent gets or is this agent's own choice. */
export function SourceMark({ custom, hint }: { custom: boolean; hint: string }) {
  return (
    <Hint text={hint}>
      <span
        className={cn(
          'shrink-0 border px-1 text-2xs',
          custom ? 'border-primary/40 bg-primary/10 text-primary' : 'border-transparent text-muted-foreground',
        )}
      >
        {custom ? 'Custom' : 'Inherited'}
      </span>
    </Hint>
  )
}
