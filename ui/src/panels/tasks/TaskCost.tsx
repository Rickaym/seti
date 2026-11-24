import { costBasis } from '@/components/account/format'
import { useAccount } from '@/hooks/useAccount'
import { useRuntimes } from '@/hooks/useRuntimes'
import { usd } from '@/lib/money'

/** What a Codex agent's cost comes from: tokens priced by a dated table, not a bill. */
function useEstimateBasis(): string {
  const asOf = useRuntimes().data?.codex.pricesAsOf
  return asOf === undefined ? 'Estimated from OpenAI prices' : `Estimated from OpenAI prices as of ${asOf}`
}

/** What the agent's turns cost across all its sessions, and whether that sum is billed. */
export function TaskCost({ cost, estimated = false }: { cost: number; estimated?: boolean }) {
  const { data } = useAccount()
  const estimate = useEstimateBasis()
  return (
    <span className="flex flex-col">
      <span className="tabular-nums">{usd(cost)}</span>
      <span className="text-2xs break-normal text-muted-foreground">{estimated ? estimate : costBasis(data)}</span>
    </span>
  )
}
