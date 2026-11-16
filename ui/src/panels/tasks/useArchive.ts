import type { ArchiveReport, RestoreReport, Task } from '@seti/shared'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { useConfirm } from '@/components/ui/confirm-context'
import { refreshTaskLists } from '@/hooks/useTasks'
import { bytesLabel } from '@/panels/resources/format'

type Named = Pick<Task, 'id' | 'title'>

const UNDO_MS = 10_000

function archiveDetail(task: Task): string {
  const freeing = task.worktree
    ? ' Its worktree is removed too if it has no uncommitted changes; its branch stays.'
    : ''
  const pinned = task.pinned ? ' It stays pinned when you restore it.' : ''
  return `Its transcript is compressed, and the folders Seti made for it are packed into a bundle.${freeing}${pinned}`
}

const keptWorktrees = (report: ArchiveReport): string =>
  report.worktrees
    .filter((worktree) => !worktree.removed)
    .map((worktree) => worktree.kept_because ?? '')
    .join('; ')

const sendArchive = async (task: Named) =>
  apiPost<ArchiveReport>(`/tasks/${task.id}/archive`, { remove_worktree: true })

/** Brings an archived agent back to the list and says so. */
export async function restoreTask(task: Named): Promise<void> {
  try {
    const report = await apiPost<RestoreReport>(`/tasks/${task.id}/unarchive`)
    toast.success(`Restored "${task.title}" with ${String(report.rows)} transcript rows`)
    refreshTaskLists()
  } catch (e) {
    toast.error(errorText(e))
  }
}

/** Archives at once, since the toast's Undo restores the agent. */
export async function archiveWithUndo(task: Named): Promise<void> {
  try {
    const kept = keptWorktrees(await sendArchive(task))
    refreshTaskLists()
    toast.success(`Archived "${task.title}"`, {
      description: kept === '' ? undefined : `Worktree kept: ${kept}`,
      duration: UNDO_MS,
      action: { label: 'Undo', onClick: () => void restoreTask(task) },
    })
  } catch (e) {
    toast.error(errorText(e))
  }
}

export function useArchive(task: Task): () => Promise<void> {
  const confirm = useConfirm()
  return async () => {
    const question = {
      title: 'Archive agent',
      message: `"${task.title}" leaves the agent list, PR updates and the group chat until you restore it.`,
      detail: archiveDetail(task),
      confirmLabel: 'Archive',
    }
    if (!(await confirm(question))) {
      return
    }
    try {
      const report = await sendArchive(task)
      const disk = report.disk_bytes > 0 ? `, ${bytesLabel(report.disk_bytes)} of disk freed` : ''
      const kept = keptWorktrees(report)
      const keptText = kept === '' ? '' : `. Worktree kept: ${kept}`
      toast.success(
        `Archived "${task.title}": ${bytesLabel(report.table_bytes)} of transcript stored as ${bytesLabel(report.stored_bytes)}${disk}${keptText}`,
      )
      refreshTaskLists()
    } catch (e) {
      toast.error(errorText(e))
    }
  }
}
