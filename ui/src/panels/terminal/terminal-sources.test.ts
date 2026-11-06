import type { TerminalRef } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentHasTerminal,
  closeTerminal,
  knownTerminals,
  recentTerminal,
  renameTerminal,
  takenTerminalNames,
  terminalSources,
  type TerminalSource,
} from '@/panels/terminal/terminal-sources'
import { terminalStore } from '@/panels/terminal/terminal-store'

vi.mock('@/panels/terminal/shells', () => ({
  shellStarts: { allow: vi.fn() },
  stopShell: vi.fn(),
}))

vi.mock('@/lib/route', () => ({ TERMINAL_ROUTE: 'terminal', navigate: vi.fn() }))

const disposers: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose()
  }
  for (const terminal of terminalStore.getSnapshot().terminals) {
    terminalStore.release(terminal.id)
  }
})

const ref = (id: string, name: string, task: string | null = null): TerminalRef => ({ id, name, task })

function source(key: string, terminals: TerminalRef[]): TerminalSource & { closed: string[]; renamed: string[] } {
  const closed: string[] = []
  const renamed: string[] = []
  const entry = {
    key,
    label: `in ${key}`,
    list: () => terminals,
    subscribe: () => () => undefined,
    close: (id: string) => {
      closed.push(id)
    },
    rename: (id: string, name: string) => {
      renamed.push(`${id}=${name}`)
    },
    closed,
    renamed,
  }
  disposers.push(terminalSources.register(entry))
  return entry
}

describe('terminal sources', () => {
  it("lists this device's terminals first, then each source's with its label, once each", () => {
    terminalStore.adopt(ref('a', 'zsh'))
    source('grid', [ref('a', 'zsh'), ref('b', 'build', 't1')])
    const known = knownTerminals()
    expect(known.map(({ terminal, label }) => `${terminal.name}:${label ?? 'own'}`)).toEqual([
      'zsh:own',
      'build:in grid',
    ])
    expect(knownTerminals()).toBe(known)
    expect([agentHasTerminal('t1'), agentHasTerminal('t2')]).toEqual([true, false])
    expect(takenTerminalNames().map((terminal) => terminal.name)).toEqual(['zsh', 'build', 'zsh'])
  })

  it('closes and renames a terminal through the source that keeps it', () => {
    const grid = source('grid', [ref('b', 'build')])
    terminalStore.adopt(ref('a', 'zsh'))
    renameTerminal('b', 'tests')
    renameTerminal('a', 'shell')
    closeTerminal('b')
    expect(grid.renamed).toEqual(['b=tests'])
    expect(grid.closed).toEqual(['b'])
    expect(terminalStore.getSnapshot().terminals.map((terminal) => terminal.name)).toEqual(['shell'])
  })

  it("opens this device's recent terminal first, and a source's when it has none", () => {
    source('grid', [ref('b', 'build')])
    expect(recentTerminal()).toBe('b')
    terminalStore.adopt(ref('a', 'zsh'))
    expect(recentTerminal()).toBe('a')
  })
})
