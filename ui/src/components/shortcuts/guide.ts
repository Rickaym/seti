import { CALL_SHORTCUT } from '@/components/ea/call-status'
import { TEXT_KEYS } from '@/components/find/find-keys'
import { PALETTE_SHORTCUT } from '@/components/palette/palette-store'
import type { PaletteCommand } from '@/components/palette/registry'
import { chordLabel, CHORDS, sectionChord } from '@/components/shortcuts/chords'
import { FIND_SHORTCUT } from '@/components/shortcuts/find'
import { TEAM_SHORTCUT } from '@/components/team/team-context'
import { lastSectionDigit } from '@/lib/sections'
import { TERMINAL_SHORTCUT } from '@/panels/terminal/terminal-shortcut'

interface GuideRow {
  keys: string
  action: string
}

interface GuideGroup {
  heading: 'Anywhere' | 'Agents' | 'Message box' | 'Files' | 'Terminal'
  rows: GuideRow[]
}

/** The Alt key's name on this device, as the panel chords show it. */
const LABEL_ALT = chordLabel(CHORDS.newAgent).split('+')[0] ?? 'Alt'
const LABEL_PRIMARY = chordLabel(CHORDS.guide).split('+')[0] ?? 'Ctrl'

const SECTION_KEYS = `${chordLabel(sectionChord(1))}-${String(lastSectionDigit)}`

const ANYWHERE: GuideRow[] = [
  { keys: PALETTE_SHORTCUT, action: 'Command palette' },
  { keys: chordLabel(CHORDS.guide), action: 'Shortcuts' },
  { keys: FIND_SHORTCUT, action: 'Find in chat or Files' },
  { keys: TEAM_SHORTCUT, action: 'Group chat' },
  { keys: TERMINAL_SHORTCUT, action: 'Terminal' },
  { keys: CALL_SHORTCUT.label, action: 'EA call' },
  { keys: SECTION_KEYS, action: 'Go to section' },
  { keys: chordLabel(CHORDS.newAgent), action: 'New agent' },
  { keys: chordLabel(CHORDS.switchLogin), action: 'Switch Claude login' },
]

const AGENTS: GuideRow[] = [
  { keys: chordLabel(CHORDS.importSessions), action: 'Import sessions' },
  { keys: chordLabel(CHORDS.filterAgents), action: 'Filter agents' },
  { keys: chordLabel(CHORDS.nextUnseen), action: 'Next unseen agent' },
  { keys: `${LABEL_ALT}+[ ]`, action: 'Step through your messages' },
  { keys: 'Esc', action: 'Stop agent' },
  { keys: 'Esc Esc', action: 'Rewind' },
]

const MESSAGE_BOX: GuideRow[] = [
  { keys: TEXT_KEYS.find, action: 'Find in the message' },
  { keys: `Enter, ${TEXT_KEYS.next}`, action: 'Next match' },
  { keys: `Shift+Enter, ${TEXT_KEYS.previous}`, action: 'Previous match' },
  { keys: TEXT_KEYS.replace, action: 'Replace in the message' },
  { keys: 'Esc', action: 'Close find, keep the match selected' },
]

const FILES: GuideRow[] = [
  { keys: TEXT_KEYS.find, action: 'Find in file' },
  { keys: `${TEXT_KEYS.next}, ${TEXT_KEYS.previous}`, action: 'Next or previous match' },
  { keys: TEXT_KEYS.replace, action: 'Replace while editing' },
  { keys: TEXT_KEYS.line, action: 'Go to line' },
  { keys: TEXT_KEYS.selectNext, action: 'Select next match' },
  { keys: TEXT_KEYS.save, action: 'Save' },
  { keys: `${TEXT_KEYS.undo}, ${TEXT_KEYS.redo}`, action: 'Undo and redo' },
]

const TERMINAL: GuideRow[] = [{ keys: 'Shift+Enter', action: 'New line in Claude Code' }]

/** A row a mod adds for keys its view binds, written with Alt or Ctrl as in its manifest. */
export interface ModGuideRow {
  keys: string
  title: string
  group: 'anywhere' | 'agents'
}

/** Alt and Ctrl as this device names them, such as Opt on Apple. */
const deviceKeys = (keys: string) => keys.replace(/^Alt\+/u, `${LABEL_ALT}+`).replace(/^Ctrl\+/u, `${LABEL_PRIMARY}+`)

/**
 * The guide's rows; palette commands with a shortcut no row names yet, then mods' rows, are
 * added at the end of their group.
 */
export function guideGroups(commands: readonly PaletteCommand[], mods: readonly ModGuideRow[] = []): GuideGroup[] {
  const named = new Set([...ANYWHERE, ...AGENTS, ...MESSAGE_BOX, ...FILES, ...TERMINAL].map((row) => row.keys))
  const extra = (agent: boolean): GuideRow[] =>
    commands.flatMap((command) =>
      command.shortcut !== undefined && !named.has(command.shortcut) && (command.group === 'Current agent') === agent
        ? [{ keys: command.shortcut, action: command.title }]
        : [],
    )
  const modRows = (group: ModGuideRow['group']): GuideRow[] =>
    mods.flatMap((row) => (row.group === group ? [{ keys: deviceKeys(row.keys), action: row.title }] : []))
  return [
    { heading: 'Anywhere', rows: [...ANYWHERE, ...extra(false), ...modRows('anywhere')] },
    { heading: 'Agents', rows: [...AGENTS, ...extra(true), ...modRows('agents')] },
    { heading: 'Message box', rows: MESSAGE_BOX },
    { heading: 'Files', rows: FILES },
    { heading: 'Terminal', rows: TERMINAL },
  ]
}
