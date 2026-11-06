import { MessageCircle } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { agentDocks, closeAgentDock, openAgentDock, type AgentDock } from './agent-docks'

const dock = (key: string, onClose: (agent: string) => void): AgentDock => ({
  key,
  title: key,
  description: null,
  icon: MessageCircle,
  view: () => null,
  onClose,
})

describe('agent docks', () => {
  it('keep one dock open per agent, telling a dock it closed when another takes its place', () => {
    const chat = vi.fn()
    const notes = vi.fn()
    const stop = [agentDocks.register(dock('a.chat', chat)), agentDocks.register(dock('b.notes', notes))]
    openAgentDock('t1', 'a.chat')
    openAgentDock('t1', 'a.chat')
    expect(chat).not.toHaveBeenCalled()
    openAgentDock('t1', 'b.notes')
    expect(chat).toHaveBeenCalledWith('t1')
    closeAgentDock('t1', 'a.chat')
    expect(notes).not.toHaveBeenCalled()
    closeAgentDock('t1')
    expect(notes).toHaveBeenCalledWith('t1')
    closeAgentDock('t1')
    expect(notes).toHaveBeenCalledTimes(1)
    stop.forEach((dispose) => {
      dispose()
    })
  })

  it('open nothing for a dock no mod registers, and forget one whose mod stopped', () => {
    const chat = vi.fn()
    openAgentDock('t2', 'gone.chat')
    closeAgentDock('t2')
    const stop = agentDocks.register(dock('a.chat', chat))
    openAgentDock('t2', 'a.chat')
    stop()
    closeAgentDock('t2')
    expect(chat).not.toHaveBeenCalled()
  })
})
