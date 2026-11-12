import type { Task } from '@seti/shared'
import { Move } from 'lucide-react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { useCommandScope } from '@/components/palette/command-scope'
import { AgentFrame } from '@/panels/tasks/AgentFrame'
import { CompactAgentHeader } from '@/panels/tasks/CompactAgentHeader'
import type { AgentAction, ActionHandlers } from '@/panels/tasks/agent-actions'
import { useAgentFrame, type AgentFrame as Frame } from '@/panels/tasks/agent-frame'

const menus = vi.hoisted(() => [] as { actions: readonly AgentAction[]; more?: readonly AgentAction[] }[])

vi.mock('@/panels/tasks/AgentMenu', () => ({
  AgentMenu: (props: { actions: readonly AgentAction[]; more?: readonly AgentAction[] }) => {
    menus.push(props)
    return null
  },
}))

vi.mock('@/mods/useModCommands', () => ({ useModAgentActions: () => [] }))

const noop = () => undefined
const arrange: AgentAction = { label: 'Arrange', icon: Move, onSelect: noop }
const frame = (over: Partial<Frame> = {}): Frame => ({ id: 'p1', focused: true, draggable: true, menu: [], ...over })
const on: ActionHandlers = {
  find: noop,
  files: noop,
  processes: noop,
  questions: noop,
  pin: noop,
  rename: noop,
  stop: noop,
  endBackground: noop,
}
const task = { id: 't1', title: 'Fix the build', pinned: false } as Task

function Probe() {
  const shown = useAgentFrame()
  return <p>{`${shown?.id ?? 'alone'} ${String(useCommandScope())}`}</p>
}

function header(given: Frame) {
  return renderToStaticMarkup(
    <CompactAgentHeader
      task={task}
      frame={given}
      title="Fix the build"
      pill={null}
      subagents={null}
      settings={null}
      running={{ busy: false, background: 0, processes: 0 }}
      on={on}
    >
      meta
    </CompactAgentHeader>,
  )
}

describe('the agent frame', () => {
  it('hands the agent view its frame, and keys only while the frame is focused', () => {
    expect(renderToStaticMarkup(<Probe />)).toContain('alone true')
    const focused = renderToStaticMarkup(
      <AgentFrame frame={frame()}>
        <Probe />
      </AgentFrame>,
    )
    expect(focused).toBe('<div data-agent-frame="" class="contents"><p>p1 true</p></div>')
    const behind = renderToStaticMarkup(
      <AgentFrame frame={frame({ focused: false })}>
        <Probe />
      </AgentFrame>,
    )
    expect(behind).toContain('p1 false')
  })

  it("puts the agent's rows in the menu, then the frame's own after them", () => {
    menus.length = 0
    header(frame({ menu: [arrange] }))
    const [menu] = menus
    expect(menu?.actions.map((action) => action.label)).toContain('Find in this chat')
    expect(menu?.more).toEqual([arrange])
  })

  it('shows a grip only while the header drags the frame', () => {
    expect(header(frame())).toContain('cursor-grab')
    expect(header(frame({ draggable: false }))).not.toContain('cursor-grab')
    expect(header(frame({ draggable: false }))).toContain('data-panel-handle')
  })
})
