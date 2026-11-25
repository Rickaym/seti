import { RUNTIME_NAMES, type SecondOpinionSpend } from '@seti/shared'
import { useEffect, useState } from 'react'
import { usd } from '@/lib/money'
import { agentOpinions } from '@/lib/opinions'

/** What the agent's second opinions cost, by the runtime that answered; nothing before the first. */
export function OpinionSpend({ taskId }: { taskId: string }) {
  const [spend, setSpend] = useState<SecondOpinionSpend[]>([])
  useEffect(() => {
    agentOpinions(taskId).then(
      (read) => {
        setSpend(read.spend)
      },
      () => {
        setSpend([])
      },
    )
  }, [taskId])
  if (spend.length === 0) {
    return null
  }
  return (
    <ul className="mt-1 text-2xs text-muted-foreground" aria-label="Second opinions">
      {spend.map((each) => (
        <li key={each.runtime}>
          Includes {usd(each.usd)}
          {each.estimated ? ' est.' : ''} for {each.count} second {each.count === 1 ? 'opinion' : 'opinions'} on{' '}
          {RUNTIME_NAMES[each.runtime]}
        </li>
      ))}
    </ul>
  )
}
