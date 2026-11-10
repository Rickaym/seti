import { Plus } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import type { PaletteCommand } from '@/components/palette/registry'
import { guideGroups } from './guide'

const command = (id: string, extra: Partial<PaletteCommand>): PaletteCommand => ({
  id,
  title: id,
  icon: Plus,
  group: 'General',
  run: () => undefined,
  ...extra,
})

describe('guideGroups', () => {
  it('names the palette, guide and find keys first', () => {
    const [anywhere] = guideGroups([])
    expect(anywhere?.rows.slice(0, 3)).toEqual([
      { keys: 'Ctrl+K', action: 'Command palette' },
      { keys: 'Ctrl+/', action: 'Shortcuts' },
      { keys: 'Ctrl+F', action: 'Find in chat or Files' },
    ])
  })

  it('adds a palette shortcut no row names, in its group, and skips ones already listed', () => {
    const groups = guideGroups([
      command('team.toggle', { title: 'Open group chat', shortcut: 'Ctrl+Shift+L' }),
      command('view.zoom', { title: 'Zoom', shortcut: 'Ctrl+=' }),
      command('agent.copy', { title: 'Copy agent', group: 'Current agent', shortcut: 'Ctrl+Shift+C' }),
      command('agent.plain', { title: 'No key', group: 'Current agent' }),
    ])
    expect(groups.map((group) => group.rows.at(-1))).toEqual([
      { keys: 'Ctrl+=', action: 'Zoom' },
      { keys: 'Ctrl+Shift+C', action: 'Copy agent' },
      { keys: 'Ctrl+Z, Ctrl+Y', action: 'Undo and redo' },
      { keys: 'Shift+Enter', action: 'New line in Claude Code' },
    ])
    expect(groups[0]?.rows.filter((row) => row.keys === 'Ctrl+Shift+L')).toEqual([
      { keys: 'Ctrl+Shift+L', action: 'Group chat' },
    ])
  })
})
