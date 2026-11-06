import type { ArchiveReport, Task } from '@seti/shared'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { useConfirm } from '@/components/ui/confirm-context'
import { refreshTaskLists } from '@/hooks/useTasks'
import { bytesLabel } from '@/panels/resources/format'

function archiveDetail(task: Task): string {
  const freeing = task.worktree
    ? ' Its worktree is removed too if it has no uncommitted changes; its branch stays.'
    : ''
  const pinned = task.pinned ? ' It stays pinned when you restore it.' : ''
  return `Its transcript is compressed, and the folders Seti made for it are packed into a bundle.${freeing}${pinned}`
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
      const report = await apiPost<ArchiveReport>(`/tasks/${task.id}/archive`, { remove_worktree: true })
      const disk = report.disk_bytes > 0 ? `, ${bytesLabel(report.disk_bytes)} of disk freed` : ''
      const kept = report.worktrees.filter((worktree) => !worktree.removed)
      const keptText = kept.length > 0 ? `. Worktree kept: ${kept.map((w) => w.kept_because ?? '').join('; ')}` : ''
      toast.success(
        `Archived "${task.title}": ${bytesLabel(report.table_bytes)} of transcript stored as ${bytesLabel(report.stored_bytes)}${disk}${keptText}`,
      )
      refreshTaskLists()
    } catch (e) {
      toast.error(errorText(e))
    }
  }
}
