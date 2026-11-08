import type { SubtaskBrief, TaskListEntry } from '@seti/shared'
import { EllipsisVertical, MessagesSquare, Network, Package, Terminal, TextSearch } from 'lucide-react'
import { useRef, useState } from 'react'
import { openPalette } from '@/components/palette/palette-store'
import { useTeamChat, useTeamChatStore } from '@/components/team/team-context'
import { unreadCount } from '@/components/team/team-store'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { subagentsLabel } from '@/lib/subtasks'
import { agentTabs, showFrame, usePlacedFrames } from '@/mods/frame-places'
import { useModAgentActions } from '@/mods/useModCommands'
import { SubagentsSheet } from '@/panels/tasks/SubagentStrip'
import { agentActions, type ActionHandlers, type AgentAction, type Running } from '@/panels/tasks/agent-actions'
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
  subtasks: readonly SubtaskBrief[]
  running: Running
  on: ActionHandlers
}

/** The overflow button and its bottom sheet of labeled rows; the badge counts running processes. */
export function PhoneActions({ task, subtasks, running, on }: PhoneActionsProps) {
  const [open, setOpen] = useState(false)
  const [subagentsOpen, setSubagentsOpen] = useState(false)
  const chosen = useRef(false)
  const mods = useModAgentActions(task.id)
  const subagents: AgentAction[] =
    subtasks.length === 0
      ? []
      : [
          {
            label: 'Subagents',
            icon: Network,
            detail: String(subtasks.length),
            ariaLabel: `Subagents, ${subagentsLabel(subtasks)}`,
            onSelect: () => {
              setSubagentsOpen(true)
            },
          },
        ]
  const agent = [...useModTabActions(task.id), ...subagents, ...agentActions(task, running, on, mods)]
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
      {subagentsOpen && (
        <SubagentsSheet
          taskId={task.id}
          subtasks={subtasks}
          onClose={() => {
            setSubagentsOpen(false)
          }}
        />
      )}
    </>
  )
}
