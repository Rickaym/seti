import type { ReactNode } from 'react'
import { CommandScope } from '@/components/palette/command-scope'
import { AgentFrameContext, type AgentFrame as Frame } from '@/panels/tasks/agent-frame'

/** Frames the agent view inside it; its palette commands, find and Esc work only while focused. */
export function AgentFrame({ frame, children }: { frame: Frame; children: ReactNode }) {
  return (
    <CommandScope value={frame.focused}>
      <AgentFrameContext value={frame}>
        <div data-agent-frame="" className="contents">
          {children}
        </div>
      </AgentFrameContext>
    </CommandScope>
  )
}
