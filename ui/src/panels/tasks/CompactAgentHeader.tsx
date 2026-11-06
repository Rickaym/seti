import type { Task } from '@seti/shared'
import { GripVertical, Square } from 'lucide-react'
import type { ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useModAgentActions } from '@/mods/useModCommands'
import { AgentMenu } from '@/panels/tasks/AgentMenu'
import { agentActions, type ActionHandlers, type Running } from '@/panels/tasks/agent-actions'
import type { AgentFrame } from '@/panels/tasks/agent-frame'

interface CompactAgentHeaderProps {
  task: Task
  frame: AgentFrame
  title: ReactNode
  pill: ReactNode
  /** The subagents button, which hides itself while there are none. */
  subagents: ReactNode
  settings: ReactNode
  running: Running
  on: ActionHandlers
  /** The line under the title: where the agent works and its PRs, then any notes. */
  children: ReactNode
}

/** The agent header in a frame: one row of title, status and actions, then the frame's own rows. */
export function CompactAgentHeader(props: CompactAgentHeaderProps) {
  const { task, frame, title, pill, subagents, settings, running, on, children } = props
  const mods = useModAgentActions(task.id)
  return (
    <div
      className={cn('agent-rule shrink-0 border-b border-border py-1 pr-1.5 pl-1', frame.draggable && 'cursor-grab')}
      data-testid="agent-header"
      data-panel-handle=""
    >
      <div className="flex items-center gap-1">
        <span aria-hidden className="flex h-6 w-4 shrink-0 items-center justify-center text-muted-foreground/70">
          {frame.draggable && <GripVertical className="size-3.5" />}
        </span>
        {title}
        {pill}
        {running.busy && (
          <Hint text="Stop the agent (Esc)">
            <Button variant="outline" size="icon-xs" aria-label="Stop" onClick={on.stop}>
              <Square />
            </Button>
          </Hint>
        )}
        {subagents}
        {settings}
        <AgentMenu actions={agentActions(task, running, on, mods)} more={frame.menu} dot={running.processes > 0} />
      </div>
      <div className="pl-5">{children}</div>
    </div>
  )
}
