import { fixCiNudge, type FixCiPr, type TaskListEntry } from '@seti/shared'
import { toast } from 'sonner'
import { sendAsUser } from '@/hooks/usePendingSends'
import { navigate, parseHash } from '@/lib/route'
import { useAgentFrame } from '@/panels/tasks/agent-frame'

/** The agent a PR belongs to: the one it is linked to, or the parent of the subagent it is. */
export type PrAgent = Pick<TaskListEntry, 'id' | 'title'>

export const prCount = (count: number) => `${String(count)} ${count === 1 ? 'PR' : 'PRs'}`

/** Sends the short Fix CI message as the user; a send that fails raises a toast that stays. */
export function askToFixCi(agent: PrAgent, message: string): void {
  void sendAsUser(agent.id, message).then((error) => {
    if (error !== null) {
      toast.error(`${agent.title} was not asked to fix CI`, { description: error, duration: Infinity })
    }
  })
}

const viewing = (agentId: string) => {
  const route = parseHash()
  return route.section === 'agents' && route.id === agentId && route.sub === null
}

/** Asks one agent to fix CI on the PRs with one short message, and opens the agent. */
export function useFixCi(agent: PrAgent): (prs: readonly FixCiPr[]) => void {
  const framed = useAgentFrame() !== null
  return (prs) => {
    askToFixCi(agent, fixCiNudge(prs))
    if (!framed && !viewing(agent.id)) {
      navigate('agents', agent.id)
    }
    const [only] = prs
    const what = prs.length === 1 && only !== undefined ? `#${String(only.number)}` : prCount(prs.length)
    toast.success(`Asked ${agent.title} to fix CI on ${what}`)
  }
}
