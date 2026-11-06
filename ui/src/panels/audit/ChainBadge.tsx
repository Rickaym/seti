import type { AuditChainStatus, AuditStatus } from '@seti/shared'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { Hint } from '@/components/Hint'

const shortHash = (hash: string) => hash.slice(0, 12)

function chainText(chain: AuditChainStatus): string {
  const head = `Head #${String(chain.head_id)} ${shortHash(chain.head_hash)}, as written to the journal each day.`
  if (chain.ok) {
    return `Every one of ${String(chain.checked)} events links to the one before it and matches its hash. ${head}`
  }
  return `${chain.problem ?? 'The chain does not verify'}. ${head}`
}

/** Whether the audit log still verifies as a hash chain, checked when the page loads or refreshes. */
export function ChainBadge({ status }: { status: AuditStatus | null }) {
  if (status === null) {
    return null
  }
  const { chain } = status
  const Icon = chain.ok ? ShieldCheck : ShieldAlert
  const label = chain.ok ? 'Chain intact' : `Chain broken at #${String(chain.broken_at ?? chain.head_id)}`
  return (
    <Hint text={chainText(chain)}>
      <span
        role="status"
        aria-label={chain.ok ? 'Audit chain intact' : 'Audit chain broken'}
        data-chain={chain.ok ? 'intact' : 'broken'}
        className={
          chain.ok
            ? 'inline-flex h-7 items-center gap-1.5 px-2 text-xs text-success'
            : 'inline-flex h-7 items-center gap-1.5 border border-destructive/40 bg-destructive/10 px-2 text-xs text-destructive'
        }
      >
        <Icon className="size-3.5" />
        {label}
      </span>
    </Hint>
  )
}
