import { RUNTIME_NAMES, type PrOpinion } from '@seti/shared'
import { MessagesSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import { agentOpinions, shownAnswer } from '@/lib/opinions'
import { relativeTime } from '@/lib/time'

/** The latest light review of a linked PR by another runtime's model, folded under its row. */
export function PrReview({ agentId, url }: { agentId: string; url: string }) {
  const [review, setReview] = useState<PrOpinion | null>(null)
  useEffect(() => {
    let live = true
    agentOpinions(agentId).then(
      (opinions) => {
        if (live) {
          setReview(opinions.reviews.find((each) => each.pr_url === url) ?? null)
        }
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [agentId, url])
  if (review === null) {
    return null
  }
  return (
    <details className="pr-3 pb-2 pl-8 text-xs" data-testid="pr-review">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground pointer-coarse:min-h-11">
        <MessagesSquare aria-hidden className="size-3 shrink-0" />
        <span className="truncate">
          Reviewed by {review.model} on {RUNTIME_NAMES[review.runtime]}, {relativeTime(review.created_at)}
        </span>
      </summary>
      <p className="mt-1 max-h-64 overflow-auto break-words whitespace-pre-wrap">{shownAnswer(review.answer)}</p>
    </details>
  )
}
