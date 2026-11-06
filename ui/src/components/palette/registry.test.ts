import type { TaskListEntry } from '@seti/shared'
import { Plus } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { availableCommands, CommandRegistry, type CommandContext, type PaletteCommand } from './registry'

const command = (id: string, extra: Partial<PaletteCommand> = {}): PaletteCommand => ({
  id,
  title: id,
  icon: Plus,
  group: 'General',
  run: () => undefined,
  ...extra,
})

const context = (agentId: string | null): CommandContext => ({
  route: { section: 'agents', id: agentId, sub: null, detail: null, terminal: null },
  agent: agentId === null ? null : ({ id: agentId } as TaskListEntry),
})

describe('CommandRegistry', () => {
  it('adds commands and removes them with the function register returns', () => {
    const registry = new CommandRegistry()
    const remove = registry.register([command('a'), command('b')])
    expect(registry.getSnapshot().map((c) => c.id)).toEqual(['a', 'b'])
    remove()
    expect(registry.getSnapshot()).toEqual([])
  })

  it('lets a later registration replace an id without the first removal taking it away', () => {
    const registry = new CommandRegistry()
    const removeFirst = registry.register([command('a', { title: 'First' })])
    const removeSecond = registry.register([command('a', { title: 'Second' })])
    expect(registry.getSnapshot().map((c) => c.title)).toEqual(['Second'])
    removeFirst()
    expect(registry.getSnapshot().map((c) => c.title)).toEqual(['Second'])
    removeSecond()
    expect(registry.getSnapshot()).toEqual([])
  })

  it('tells subscribers about changes and keeps the snapshot stable between them', () => {
    const registry = new CommandRegistry()
    const listener = vi.fn()
    const unsubscribe = registry.subscribe(listener)
    registry.register([command('a')])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(registry.getSnapshot()).toBe(registry.getSnapshot())
    unsubscribe()
    registry.register([command('b')])
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('availableCommands', () => {
  it('keeps commands whose when holds for the context, and those without one', () => {
    const commands = [
      command('always'),
      command('agent.only', { when: (c) => c.agent !== null }),
      command('this.agent', { when: (c) => c.agent?.id === 'x' }),
    ]
    expect(availableCommands(commands, context(null)).map((c) => c.id)).toEqual(['always'])
    expect(availableCommands(commands, context('y')).map((c) => c.id)).toEqual(['agent.only', 'always'])
    expect(availableCommands(commands, context('x')).map((c) => c.id)).toEqual(['agent.only', 'always', 'this.agent'])
  })

  it('orders by group and then by title, whatever the registration order', () => {
    const commands = [
      command('theme', { title: 'Toggle theme', group: 'View' }),
      command('settings', { title: 'Settings: Repos', group: 'Settings' }),
      command('new', { title: 'New agent', group: 'General' }),
      command('stop', { title: 'Stop agent', group: 'Current agent' }),
      command('chat', { title: 'Open group chat', group: 'General' }),
    ]
    expect(availableCommands(commands, context(null)).map((c) => c.id)).toEqual([
      'stop',
      'new',
      'chat',
      'theme',
      'settings',
    ])
  })
})
