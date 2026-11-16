import { type ReviewGap } from '@seti/shared'
import { Info, ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** One quiet line per server that review rules cover in part, with a way to choose the rest. */
export function ReviewGaps({ gaps, onChoose }: { gaps: readonly ReviewGap[]; onChoose: (gap: ReviewGap) => void }) {
  return (
    <ul aria-label="Review coverage">
      {gaps.map((gap) => (
        <li
          key={gap.server}
          className="flex min-h-8 items-center gap-2 border-b border-border px-3 py-1 text-2xs text-muted-foreground pointer-coarse:min-h-11"
        >
          <Info className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {gap.uncovered === 1
              ? `1 other ${gap.label} tool can write or send and is not reviewed.`
              : `${String(gap.uncovered)} other ${gap.label} tools can write or send and are not reviewed.`}
          </span>
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Choose ${gap.label} tools to review`}
            onClick={() => {
              onChoose(gap)
            }}
          >
            <ListChecks />
            Choose
          </Button>
        </li>
      ))}
    </ul>
  )
}
