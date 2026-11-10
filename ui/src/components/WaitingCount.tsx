import { CountBadge } from '@/components/CountBadge'

/** The count of knowledge proposals on the Context section; aria-describedby can name `id`. */
export function WaitingCount({ count, id, className }: { count: number; id: string; className?: string }) {
  return (
    <CountBadge data-knowledge-waiting className={className}>
      <span aria-hidden="true">{count}</span>
      <span id={id} hidden>
        {count === 1 ? '1 knowledge proposal waits' : `${String(count)} knowledge proposals wait`}
      </span>
    </CountBadge>
  )
}
