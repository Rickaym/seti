import { useNow } from '@/hooks/useNow'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'

const TICK_MS = 30_000

const fullTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** "9m ago", kept current, with the full date and time on hover. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const now = useNow(true, TICK_MS)
  return (
    <time dateTime={iso} title={fullTime(iso)} className={cn('tabular-nums', className)}>
      {relativeTime(iso, now)}
    </time>
  )
}
