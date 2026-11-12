import { CountBadge } from '@/components/CountBadge'

interface SectionCountProps {
  count: number
  /** What the count means, read through aria-describedby on `id`. */
  description: string
  id: string
  className?: string
}

/** The count on a section's sidebar row, such as the questions that wait on the user. */
export function SectionCount({ count, description, id, className }: SectionCountProps) {
  return (
    <CountBadge data-section-count className={className}>
      <span aria-hidden="true">{count}</span>
      <span id={id} hidden>
        {description}
      </span>
    </CountBadge>
  )
}
