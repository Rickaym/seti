import type { TaskListEntry } from '@seti/shared'
import { Square } from 'lucide-react'
import type { ReactNode } from 'react'
import { DetailBar, DetailBarActions } from '@/components/DetailBar'
import { Button } from '@/components/ui/button'
import { useAgentRoom } from '@/hooks/useAgentRoom'
import { PhoneActions } from '@/panels/tasks/PhoneActions'
import { PhoneBack } from '@/panels/tasks/PhoneBack'
import type { ActionHandlers, Running } from '@/panels/tasks/agent-actions'

interface PhoneHeaderProps {
  task: TaskListEntry
  /** The agent's name, or the field that renames it. */
  title: ReactNode
  /** The status light, which a mod's marker may draw. */
  light: ReactNode
  /** The subagents button, which hides itself while there are none. */
  subagents: ReactNode
  settings: ReactNode
  running: Running
  on: ActionHandlers
}

/** The phone's agent header, the terminal's bar: back, status, name and actions. */
export function PhoneHeader({ task, title, light, subagents, settings, running, on }: PhoneHeaderProps) {
  useAgentRoom()
  return (
    <DetailBar className="typing:hidden" data-testid="agent-header">
      <PhoneBack />
      {light}
      <div className="flex min-w-0 flex-1 items-center px-1 [&>h2]:text-sm">{title}</div>
      <DetailBarActions>
        {subagents}
        {running.busy && (
          <Button variant="ghost" size="icon-sm" aria-label="Stop" onClick={on.stop}>
            <Square />
          </Button>
        )}
        {settings}
        <PhoneActions task={task} running={running} on={on} />
      </DetailBarActions>
    </DetailBar>
  )
}
