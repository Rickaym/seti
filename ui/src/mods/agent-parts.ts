import type { ModAgents, ModTerminals } from '@seti/mod-api'
import { agentColorAttr } from '@/lib/agent-color-sheet'
import { navigate } from '@/lib/route'
import { FilesDockHost } from '@/panels/files/FilesDockHost'
import { AgentFrame } from '@/panels/tasks/AgentFrame'
import { StatusLight } from '@/panels/tasks/StatusPill'
import { UnseenDot } from '@/panels/tasks/UnseenDot'
import { AGENT_DRAG_TYPE, filterAgents, shortRepoLabel } from '@/panels/tasks/agent-list'
import { TerminalName } from '@/panels/terminal/TerminalName'
import { TerminalView } from '@/panels/terminal/TerminalView'
import { shellStarts, stopShell } from '@/panels/terminal/shells'
import { HOME_PLACE } from '@/panels/terminal/terminal-list'
import { openTerminalAlone, takenTerminalNames } from '@/panels/terminal/terminal-sources'
import { mintTerminal, terminalStore, useTerminalList } from '@/panels/terminal/terminal-store'
import { GuardedAgentView } from './GuardedAgentView'

/** Seti's agent pieces every mod's UI half shares; its docks and messages are added per mod. */
export const MOD_AGENTS: Omit<ModAgents, 'send' | 'openDock' | 'closeDock'> = {
  View: GuardedAgentView,
  Frame: AgentFrame,
  FilesDockHost,
  StatusLight,
  UnseenDot,
  colorAttr: agentColorAttr,
  filter: filterAgents,
  placeLabel: shortRepoLabel,
  DRAG_TYPE: AGENT_DRAG_TYPE,
  open: (id) => {
    navigate('agents', id)
  },
}

/** Seti's terminals, as bundled mods reach them. */
export const MOD_TERMINALS: ModTerminals = {
  View: TerminalView,
  Name: TerminalName,
  mint: (place) => mintTerminal(place, takenTerminalNames()),
  HOME: HOME_PLACE,
  adopt: terminalStore.adopt,
  release: terminalStore.release,
  stop: stopShell,
  allowStart: shellStarts.allow,
  openAlone: openTerminalAlone,
  useOwn: () => useTerminalList().terminals,
}
