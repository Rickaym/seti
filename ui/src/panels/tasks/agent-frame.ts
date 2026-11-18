import { createContext, useContext } from 'react'
import type { AgentAction } from '@/panels/tasks/agent-actions'

/**
 * An agent view shown inside something else, such as a layout's panel or a dock: it gets the
 * compact header, keeps a short tail of rows and takes keys only while focused.
 */
export interface AgentFrame {
  /** The frame's own id, such as its panel's. */
  id: string
  focused: boolean
  /** The header drags the frame, so it shows a grip. */
  draggable: boolean
  /** Rows the frame adds to the agent's More actions menu, after a separator. */
  menu: readonly AgentAction[]
  /** Shows the status and the latest message in place of the transcript and the reply box. */
  calm?: boolean
  /** Esc pressed in the focused frame while nothing runs, such as to make the frame calm again. */
  onEscape?: () => void
}

export const AgentFrameContext = createContext<AgentFrame | null>(null)

/** The frame the agent view sits in, or null when it shows alone. */
export const useAgentFrame = (): AgentFrame | null => useContext(AgentFrameContext)
