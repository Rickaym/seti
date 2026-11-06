import { costBasis } from '@/components/account/format'
import { useAccount } from '@/hooks/useAccount'
import { usd } from '@/lib/money'

/** What the agent's turns cost across all its sessions, and whether that sum is billed. */
export function TaskCost({ cost }: { cost: number }) {
  const { data } = useAccount()
  return (
    <span className="flex flex-col">
      <span className="tabular-nums">{usd(cost)}</span>
      <span className="text-2xs break-normal text-muted-foreground">{costBasis(data)}</span>
    </span>
  )
}
