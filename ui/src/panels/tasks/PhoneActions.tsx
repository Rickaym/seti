import type { TaskListEntry } from '@seti/shared'
import { EllipsisVertical, GitPullRequest, MessagesSquare, Package, Terminal, TextSearch } from 'lucide-react'
import { useRef, useState } from 'react'
import { openPalette } from '@/components/palette/palette-store'
import { useTeamChat, useTeamChatStore } from '@/components/team/team-context'
import { unreadCount } from '@/components/team/team-store'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { refreshTasks } from '@/hooks/useTasks'
import { agentTabs, showFrame, usePlacedFrames } from '@/mods/frame-places'
import { useModAgentActions } from '@/mods/useModCommands'
import { AgentPrsSheet } from '@/panels/tasks/LinkedPrList'
import { PrPicker } from '@/panels/tasks/PrPicker'
import { agentActions, type ActionHandlers, type AgentAction, type Running } from '@/panels/tasks/agent-actions'
import { orderLinkedPrs } from '@/panels/tasks/linked-prs'
import { prsPath } from '@/panels/tasks/pr-links'
import { usePrStatuses } from '@/panels/tasks/usePrStatuses'
import { useOpenTerminal } from '@/panels/terminal/useOpenTerminal'

/** Mod views placed beside agents, which the desktop header shows as icons, as rows. */
function useModTabActions(taskId: string): AgentAction[] {
  return usePlacedFrames(agentTabs).map((tab) => ({
    label: tab.title,
    icon: Package,
    onSelect: () => {
      showFrame({ key: tab.key, agentId: taskId })
    },
  }))
}

/** What the app header and its menu offer, which step aside in the phone agent view. */
function useAppActions(): AgentAction[] {
  const team = useTeamChatStore()
  const openTerminal = useOpenTerminal()
  const unread = unreadCount(useTeamChat())
  const chat: AgentAction = {
    label: 'Group chat',
    icon: MessagesSquare,
    onSelect: () => {
      team.toggle()
    },
  }
  if (unread > 0) {
    chat.detail = `${String(unread)} unread`
    chat.ariaLabel = `Group chat, ${String(unread)} unread`
  }
  const search: AgentAction = {
    label: 'Search Seti',
    icon: TextSearch,
    onSelect: () => {
      openPalette()
    },
  }
  const terminal: AgentAction = {
    label: 'Terminal',
    icon: Terminal,
    onSelect: () => {
      void openTerminal()
    },
  }
  return [terminal, search, chat]
}

/** The agent's linked PRs with their live status, in a sheet that unmounts on close. */
function LinkedPrs({ task, onClose }: { task: TaskListEntry; onClose: () => void }) {
  const { statuses } = usePrStatuses(task.pr_urls)
  const prs = orderLinkedPrs(task.pr_urls, statuses, task.pr_states.by_url, task.repo_slug)
  const path = prsPath(task.id)
  return (
    <AgentPrsSheet
      prs={prs}
      path={path}
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

function ActionRow({ action, onChosen }: { action: AgentAction; onChosen: () => void }) {
  const Icon = action.icon
  return (
    <button
      type="button"
      aria-label={action.ariaLabel}
      className="flex min-h-11 items-center gap-3 px-4 text-left text-sm text-foreground/80 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => {
        onChosen()
        action.onSelect()
      }}
    >
      <Icon className="size-[18px] shrink-0" />
      <span className="min-w-0 flex-1 truncate">{action.label}</span>
      {action.detail !== undefined && (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{action.detail}</span>
      )}
    </button>
  )
}

interface PhoneActionsProps {
  task: TaskListEntry
  running: Running
  on: ActionHandlers
}

/** The overflow button and its bottom sheet of labeled rows; the badge counts running processes. */
export function PhoneActions({ task, running, on }: PhoneActionsProps) {
  const [open, setOpen] = useState(false)
  const [prsOpen, setPrsOpen] = useState(false)
  const chosen = useRef(false)
  const mods = useModAgentActions(task.id)
  const linked = task.pr_urls.length
  const prs: AgentAction = {
    label: 'Pull requests',
    icon: GitPullRequest,
    onSelect: () => {
      setPrsOpen(true)
    },
  }
  if (linked > 0) {
    prs.detail = String(linked)
    prs.ariaLabel = `Pull requests, ${String(linked)} linked`
  }
  const agent = [...useModTabActions(task.id), prs, ...agentActions(task, running, on, mods)]
  const app = useAppActions()
  const badge = running.processes
  const row = (action: AgentAction) => (
    <ActionRow
      key={action.label}
      action={action}
      onChosen={() => {
        chosen.current = true
        setOpen(false)
      }}
    />
  )
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        className="relative shrink-0"
        aria-label="More actions"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          chosen.current = false
          setOpen(true)
        }}
      >
        <EllipsisVertical />
        {badge > 0 && (
          <span
            aria-hidden
            className="absolute top-1.5 right-1.5 min-w-4 rounded-full bg-primary px-1 text-2xs/4 font-semibold text-primary-foreground tabular-nums"
          >
            {badge}
          </span>
        )}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          aria-describedby={undefined}
          className="gap-0 py-2"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
          }}
          onCloseAutoFocus={(e) => {
            if (chosen.current) {
              e.preventDefault()
            }
          }}
        >
          <SheetTitle className="sr-only">Agent actions</SheetTitle>
          {agent.map(row)}
          <div role="separator" className="my-1 border-t border-border" />
          {app.map(row)}
        </SheetContent>
      </Sheet>
      {prsOpen && (
        <LinkedPrs
          task={task}
          onClose={() => {
            setPrsOpen(false)
          }}
        />
      )}
    </>
  )
}
