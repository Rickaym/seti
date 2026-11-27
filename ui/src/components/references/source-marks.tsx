import { Check } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { asReadAt } from '@/components/references/source-match'

const VERIFIED = 'The quote is in what the agent read from this source'

/** A quiet check beside a quote the ledger found in the cited item. */
export function VerifiedMark() {
  return (
    <Hint text={VERIFIED}>
      <span className="inline-flex shrink-0 items-center text-muted-foreground" data-testid="quote-verified">
        <Check className="size-3" aria-label={VERIFIED} />
      </span>
    </Hint>
  )
}

const MOVED = 'The link names a branch. The agent read this at that commit; the branch may have moved since.'

/** A branch link's match, said with the commit it was read at, in muted text. */
export function AsReadAt({ commit }: { commit: string }) {
  return (
    <Hint text={MOVED}>
      <span className="shrink-0 text-muted-foreground" data-testid="source-as-read">
        {asReadAt(commit)}
      </span>
    </Hint>
  )
}

/** A link the agent cites but never read, said plainly and in muted text. */
export function NotRead() {
  return (
    <span className="shrink-0 text-muted-foreground" data-testid="source-not-read">
      not read by this agent
    </span>
  )
}
