import type { FixCiPr } from '@seti/shared'
import { Wrench } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { prCount, useFixCi, type PrAgent } from '@/panels/tasks/fix-ci'

const INLINE =
  'flex h-6 -my-1.5 shrink-0 items-center gap-1 text-xs whitespace-nowrap text-destructive hover:underline pointer-coarse:-my-3.5 pointer-coarse:h-11'

interface AgentFixCiProps {
  agent: PrAgent
  /** The agent's open PRs with failing CI; with none there is no button. */
  prs: readonly FixCiPr[]
  /** A text button on the line of PR chips, where a filled button would crowd the header. */
  inline?: boolean
  onSent?: () => void
}

/** One Fix CI for every failing PR of an agent: one click, one short message naming them all. */
export function AgentFixCi({ agent, prs, inline = false, onSent }: AgentFixCiProps) {
  const fix = useFixCi(agent)
  if (prs.length === 0) {
    return null
  }
  const send = () => {
    fix(prs)
    onSent?.()
  }
  const covered = prs.length === 1 ? 'its 1 PR' : `all ${prCount(prs.length)}`
  const hint = `Ask the agent to fix failing CI on ${covered}`
  if (inline) {
    return (
      <Hint text={hint}>
        <button type="button" className={INLINE} data-testid="fix-ci-all" onClick={send}>
          <Wrench className="size-3.5" />
          Fix CI
        </button>
      </Hint>
    )
  }
  return (
    <Hint text={hint}>
      <Button size="xs" className="shrink-0 pointer-coarse:min-h-11" data-testid="fix-ci-all" onClick={send}>
        <Wrench />
        Fix CI
      </Button>
    </Hint>
  )
}
