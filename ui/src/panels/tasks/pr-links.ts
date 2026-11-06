import { toast } from 'sonner'
import { apiDelete, apiPost, errorText } from '@/api'
import { toastUndo } from '@/lib/undo'

/** Where a PR list links and unlinks: the task itself, or one subagent of it. */
export const prsPath = (taskId: string, toolUseId?: string) =>
  toolUseId === undefined ? `/tasks/${taskId}/prs` : `/tasks/${taskId}/subtasks/${toolUseId}/prs`

export async function linkPr(path: string, url: string): Promise<void> {
  await apiPost(path, { url })
}

/** Unlinks at once and offers Undo in the toast, which links the PR again. */
export async function unlinkWithUndo(path: string, url: string, label: string, onChanged: () => void): Promise<void> {
  try {
    await apiDelete(`${path}?url=${encodeURIComponent(url)}`)
    onChanged()
    toastUndo(`Unlinked ${label}`, async () => {
      await linkPr(path, url)
      onChanged()
    })
  } catch (e) {
    toast.error(errorText(e))
  }
}

/** Keeps a PR popover open while the pointer is on a toast, so Undo does not close it. */
export const keepForToasts = (e: Event) => {
  if (e.target instanceof Element && e.target.closest('[data-sonner-toaster]') !== null) {
    e.preventDefault()
  }
}
