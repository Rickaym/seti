import type { ArchivedTaskEntry, RestoreReport } from '@seti/shared'
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { BackButton, DetailHeader, DetailTitle } from '@/components/SplitPane'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { useArchivedTranscript } from '@/hooks/useArchivedTranscript'
import { refreshTaskLists } from '@/hooks/useTasks'
import { useTranscriptBlocks } from '@/hooks/useTranscriptBlocks'
import { prShortLabel } from '@/lib/pr-number'
import { navigate } from '@/lib/route'
import { relativeTime } from '@/lib/time'
import { FilesSplit, FilesToggle } from '@/panels/files/FilesSplit'
import { useFilesPane } from '@/panels/files/useFilesPane'
import { bytesLabel } from '@/panels/resources/format'
import { ArchivedPill } from '@/panels/tasks/StatusPill'
import { TranscriptPane } from '@/panels/tasks/TranscriptPane'
import { WorkspaceSelect } from '@/panels/tasks/workspaces/WorkspaceSelect'

const NONE = [] as const

function archiveSummary(task: ArchivedTaskEntry): string {
  const { archive } = task
  const by = archive.actor === 'system' ? 'by the auto-archive rule' : 'by you'
  const rows = `${String(archive.rows)} transcript ${archive.rows === 1 ? 'row' : 'rows'}`
  return `Archived ${relativeTime(archive.archived_at)} ${by}: ${rows}, ${bytesLabel(archive.table_bytes)} stored as ${bytesLabel(archive.stored_bytes)}.`
}

function worktreeNote(task: ArchivedTaskEntry): string | null {
  const removed = task.archive.worktrees.filter((worktree) => worktree.removed)
  const kept = task.archive.worktrees.filter((worktree) => !worktree.removed)
  const parts = [
    ...(removed.length === 0 ? [] : ['The worktree was removed to free disk; Restore checks its branch out again.']),
    ...kept.map((worktree) => `Kept ${worktree.dir}: ${worktree.kept_because ?? ''}.`),
  ]
  return parts.length === 0 ? null : parts.join(' ')
}

/** Where the agent's folders went: packed with their size, waiting with the reason, or nothing. */
function filesNote(task: ArchivedTaskEntry): string | null {
  const { files } = task.archive
  if (files === null) {
    return 'Its folders are being packed.'
  }
  if (files.state === 'pending') {
    return `Its folders wait to be packed: ${files.reason ?? 'the next sweep tries again'}.`
  }
  if (files.state === 'bundled') {
    return `Its folders are packed into ${bytesLabel(files.bytes)}; Restore unpacks them.`
  }
  return files.bytes > 0 ? `Its uncommitted changes are saved in ${bytesLabel(files.bytes)} of patches.` : null
}

/** An archived agent, read-only: its transcript comes from the archive, with Restore and Delete. */
export function ArchivedTaskDetail({ task }: { task: ArchivedTaskEntry }) {
  const confirm = useConfirm()
  const transcript = useArchivedTranscript(task.id)
  const blocks = useTranscriptBlocks(task.id)
  const [restoring, setRestoring] = useState(false)
  const note = [worktreeNote(task), filesNote(task)].filter((part) => part !== null).join(' ')
  const files = useFilesPane(task.id)

  const restore = async () => {
    setRestoring(true)
    try {
      const report = await apiPost<RestoreReport>(`/tasks/${task.id}/unarchive`)
      toast.success(`Restored "${task.title}" with ${String(report.rows)} transcript rows`)
      refreshTaskLists()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setRestoring(false)
    }
  }

  const remove = async () => {
    const kept = task.archive.worktrees.some((worktree) => !worktree.removed)
      ? ' Its kept worktree is removed too.'
      : ''
    const packed = (task.archive.files?.path ?? null) === null ? '' : ' Its packed folders are deleted too.'
    const message = `Delete "${task.title}" for good? Its archived transcript cannot be restored.${kept}${packed}`
    if (!(await confirm({ title: 'Delete agent', message, confirmLabel: 'Delete', variant: 'destructive' }))) {
      return
    }
    try {
      await apiDelete(`/tasks/${task.id}`)
      navigate('agents')
      refreshTaskLists()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  return (
    <FilesSplit taskId={task.id} pane={files} readOnly>
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <DetailHeader
          actions={
            <>
              <FilesToggle pane={files} />
              <Hint text="Bring the agent back: its transcript, PR updates and group chat">
                <Button size="sm" disabled={restoring} onClick={() => void restore()}>
                  <ArchiveRestore />
                  {restoring ? 'Restoring...' : 'Restore'}
                </Button>
              </Hint>
              <Hint text="Delete agent">
                <Button variant="outline" size="icon-sm" aria-label="Delete agent" onClick={() => void remove()}>
                  <Trash2 />
                </Button>
              </Hint>
            </>
          }
        >
          <div className="flex items-center gap-2">
            <BackButton section="agents" label="agents" />
            <DetailTitle>{task.title}</DetailTitle>
            <ArchivedPill />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="truncate" title={task.cwd}>
              {task.repos.length > 0 ? task.repos.map((repo) => repo.slug).join(', ') : task.cwd}
            </span>
            {task.pr_urls.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                {prShortLabel(url, task.repo_slug)}
              </a>
            ))}
            <WorkspaceSelect task={task} />
          </div>
        </DetailHeader>
        <div
          role="status"
          aria-label="Archived agent"
          className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/50 px-5 py-2 text-xs text-muted-foreground max-md:px-3"
        >
          <Archive className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {archiveSummary(task)} Read-only until restored. {note}
          </span>
        </div>
        <TranscriptPane
          taskId={task.id}
          stream={transcript}
          rewinds={NONE}
          running={false}
          subtasks={NONE}
          blocks={blocks}
          load={{ pending: !transcript.loaded, failed: transcript.failed, onRetry: transcript.retry }}
        >
          {transcript.loaded && transcript.messages.length === 0 && (
            <p className="text-sm text-muted-foreground">The transcript is empty.</p>
          )}
        </TranscriptPane>
      </div>
    </FilesSplit>
  )
}
