import type { SubtaskBrief, Task, TaskListEntry } from '@seti/shared'
import { OctagonX, Pin, Square } from 'lucide-react'
import type { ReactNode } from 'react'
import { FindButton } from '@/components/ChatFindBar'
import { Hint } from '@/components/Hint'
import { DetailHeader } from '@/components/SplitPane'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'
import { ModHeaderActions } from '@/mods/ModHeaderActions'
import { AgentModTabs } from '@/mods/ModViewSheet'
import { FilesToggle } from '@/panels/files/FilesSplit'
import type { FilesPane } from '@/panels/files/useFilesPane'
import { ProcessesButton } from '@/panels/processes/ProcessesPanel'
import type { AgentProcessesState } from '@/panels/processes/useAgentProcesses'
import { CompactAgentHeader } from '@/panels/tasks/CompactAgentHeader'
import { PhoneHeader } from '@/panels/tasks/PhoneHeader'
import { StatusLine } from '@/panels/tasks/StatusLine'
import { SubagentsButton } from '@/panels/tasks/SubagentStrip'
import { TaskPrs } from '@/panels/tasks/TaskPrs'
import { TaskTitle } from '@/panels/tasks/TaskTitle'
import type { ActionHandlers, Running } from '@/panels/tasks/agent-actions'
import type { AgentFrame } from '@/panels/tasks/agent-frame'
import { repoLabel, shortRepoLabel } from '@/panels/tasks/agent-list'
import { usePin } from '@/panels/tasks/usePin'

/** Most PRs the header row shows, fewer when they do not fit one line; the rest open from a list. */
const SHOWN_PRS = 4
const COMPACT_SHOWN_PRS = 2

interface TaskMetaProps {
  task: TaskListEntry
  /** Names the repo or folder alone and shows fewer PRs. */
  compact?: boolean
}

/** Where the agent works, its PRs and its status line on one line. */
function TaskMeta({ task, compact = false }: TaskMetaProps) {
  return (
    <div className="flex min-w-0 items-center gap-x-3 text-xs text-muted-foreground">
      <span className="min-w-0 truncate" title={task.cwd}>
        {compact ? shortRepoLabel(task) : repoLabel(task)}
      </span>
      <TaskPrs task={task} limit={compact ? COMPACT_SHOWN_PRS : SHOWN_PRS} />
      <StatusLine text={task.blocked ?? task.status_line} className="min-w-[10ch] flex-1" />
    </div>
  )
}

/** Pins a long-running agent: listed first, and never archived or cleaned up on its own. */
function PinToggle({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const pin = usePin(task, onChanged)
  return (
    <ToggleButton
      pressed={task.pinned}
      onPressedChange={(pinned) => void pin(pinned)}
      icon={Pin}
      label="Pin"
      iconOnly
      wideLabel
      variant="ghost"
      hint={
        task.pinned
          ? 'Pinned: listed first and never archived or cleaned up on its own. Click to unpin.'
          : 'Pin this long-running agent: listed first and never archived or cleaned up on its own'
      }
    />
  )
}

interface AgentHeaderProps {
  task: TaskListEntry
  onChanged: () => void
  /** The frame the agent shows in, which gets the compact header. */
  frame: AgentFrame | null
  narrow: boolean
  /** The status pill with its unseen dot and badges. */
  pill: ReactNode
  /** The status as a small light, for the phone's one-row header. */
  light: ReactNode
  subtasks: readonly SubtaskBrief[]
  /** The title as it is being renamed, or null. */
  titleDraft: string | null
  onTitleDraft: (draft: string | null) => void
  settings: (compact?: boolean) => ReactNode
  running: Running
  /** A shell command runs rather than a turn, which Stop then ends. */
  shell: boolean
  on: ActionHandlers
  processes: AgentProcessesState
  filesPane: FilesPane
}

/** The agent's header: compact in a frame, a phone's own, else the full desktop row. */
export function AgentHeader(props: AgentHeaderProps) {
  const { task, onChanged, frame, pill, subtasks, titleDraft, onTitleDraft, settings, running, on } = props
  const compactTitle = (
    <TaskTitle task={task} onChanged={onChanged} draft={titleDraft} onDraftChange={onTitleDraft} compact />
  )
  if (frame !== null) {
    return (
      <CompactAgentHeader
        task={task}
        frame={frame}
        title={compactTitle}
        pill={pill}
        subagents={<SubagentsButton taskId={task.id} subtasks={subtasks} compact />}
        settings={settings(true)}
        running={running}
        on={on}
      >
        <TaskMeta task={task} compact />
      </CompactAgentHeader>
    )
  }
  if (props.narrow) {
    return (
      <PhoneHeader
        task={task}
        title={compactTitle}
        light={props.light}
        subtasks={subtasks}
        settings={settings()}
        running={running}
        on={on}
      />
    )
  }
  return (
    <DetailHeader
      actions={
        <>
          {running.busy && (
            <Hint text={props.shell ? 'Stop the shell command (Esc)' : 'Stop the agent (Esc)'}>
              <Button variant="outline" size="sm" onClick={on.stop}>
                <Square />
                Stop
              </Button>
            </Hint>
          )}
          {running.background > 0 && (
            <Button variant="outline" size="sm" onClick={on.endBackground}>
              <OctagonX className="mr-1.5 size-3.5" />
              Stop background work
            </Button>
          )}
          <SubagentsButton taskId={task.id} subtasks={subtasks} />
          <FindButton onClick={on.find} />
          <ProcessesButton processes={props.processes} />
          <AgentModTabs taskId={task.id} />
          <FilesToggle pane={props.filesPane} variant="ghost" />
          <PinToggle task={task} onChanged={onChanged} />
          <ModHeaderActions agent={task.id} />
          {settings()}
        </>
      }
      below={<TaskMeta task={task} />}
    >
      <div className="flex items-center gap-2">
        <TaskTitle task={task} onChanged={onChanged} draft={titleDraft} onDraftChange={onTitleDraft} />
        {pill}
      </div>
    </DetailHeader>
  )
}
