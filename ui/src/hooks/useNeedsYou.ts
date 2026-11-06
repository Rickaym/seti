import { listedStatus, waitsOnYou } from '@seti/shared'
import { useTasks } from '@/hooks/useTasks'
import { useCurrentWorkspace } from '@/hooks/useWorkspaces'
import { revealNeedsYou } from '@/lib/needs-you'
import { chooseWorkspace, needsYouWorkspace } from '@/panels/tasks/workspaces/workspace-store'

/** Agents that need the user in every workspace, and how to open the Needs you group. */
export function useNeedsYou(): { titles: string[]; open: () => void } {
  const { tasks } = useTasks()
  const { currentId } = useCurrentWorkspace()
  const titles = tasks.filter((t) => waitsOnYou(t, listedStatus(t))).map((t) => t.title)
  const open = () => {
    const target = needsYouWorkspace(tasks, currentId)
    if (target !== null) {
      chooseWorkspace(target)
    }
    revealNeedsYou()
  }
  return { titles, open }
}

/** "1 agent needs you" or "3 agents need you". */
export const needsYouLabel = (count: number) => `${String(count)} ${count === 1 ? 'agent needs' : 'agents need'} you`
