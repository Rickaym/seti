import type { TaskListEntry } from '@seti/shared'
import { GitPullRequest } from 'lucide-react'
import { useState } from 'react'
import { CountBadge } from '@/components/CountBadge'
import { Button } from '@/components/ui/button'
import { refreshTasks } from '@/hooks/useTasks'
import { AgentPrsSheet } from '@/panels/tasks/LinkedPrList'
import { PrPicker } from '@/panels/tasks/PrPicker'
import { orderLinkedPrs } from '@/panels/tasks/linked-prs'
import { prsPath } from '@/panels/tasks/pr-links'
import { usePrStatuses } from '@/panels/tasks/usePrStatuses'

/** The agent's linked PRs with their live status, in a sheet that unmounts on close. */
function LinkedPrs({ task, onClose }: { task: TaskListEntry; onClose: () => void }) {
  const { statuses } = usePrStatuses(task.pr_urls)
  const prs = orderLinkedPrs(task.pr_urls, statuses, task.pr_states.by_url, task.repo_slug)
  const path = prsPath(task.id)
  return (
    <AgentPrsSheet
      prs={prs}
      path={path}
      agent={task}
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
      picker={(done) => (
        <PrPicker
          task={task}
          path={path}
          linked={task.pr_urls}
          onLinked={() => {
            done()
            refreshTasks()
          }}
        />
      )}
    />
  )
}

/** The phone header's PR button, badged with how many are linked; it also links one. */
export function PhonePrsButton({ task }: { task: TaskListEntry }) {
  const [open, setOpen] = useState(false)
  const linked = task.pr_urls.length
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        className="relative shrink-0"
        aria-label={linked > 0 ? `Pull requests, ${String(linked)} linked` : 'Pull requests'}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="prs-button"
        onClick={() => {
          setOpen(true)
        }}
      >
        <GitPullRequest />
        {linked > 0 && <CountBadge aria-hidden>{linked}</CountBadge>}
      </Button>
      {open && (
        <LinkedPrs
          task={task}
          onClose={() => {
            setOpen(false)
          }}
        />
      )}
    </>
  )
}
