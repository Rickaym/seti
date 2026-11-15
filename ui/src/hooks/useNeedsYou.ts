import { heldAgents, listedStatus, waitsOnYou } from '@seti/shared'
import { useRequests } from '@/hooks/useRequests'
import { useTasks } from '@/hooks/useTasks'
import { useCurrentWorkspace } from '@/hooks/useWorkspaces'
import { revealNeedsYou } from '@/lib/needs-you'
import { navigate } from '@/lib/route'
import { chooseWorkspace, needsYouWorkspace } from '@/panels/tasks/workspaces/workspace-store'

/**
 * Agents that need the user in every workspace, and how to open them: the Requests panel when a
 * request there holds every one of them, else the Needs you group, which shows them all.
 */
export function useNeedsYou(): { titles: string[]; inRequests: boolean; open: () => void } {
  const { tasks } = useTasks()
  const { requests } = useRequests()
  const { currentId } = useCurrentWorkspace()
  const waiting = tasks.filter((t) => waitsOnYou(t, listedStatus(t)))
  const held = heldAgents(requests)
  const inRequests = waiting.length > 0 && waiting.every((t) => held.has(t.id))
  const open = () => {
    if (inRequests) {
      navigate('requests')
      return
    }
    const target = needsYouWorkspace(tasks, currentId)
    if (target !== null) {
      chooseWorkspace(target)
    }
    revealNeedsYou()
  }
  return { titles: waiting.map((t) => t.title), inRequests, open }
}

/** "1 agent needs you" or "3 agents need you". */
export const needsYouLabel = (count: number) => `${String(count)} ${count === 1 ? 'agent needs' : 'agents need'} you`
