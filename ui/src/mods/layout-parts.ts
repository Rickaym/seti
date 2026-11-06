import type { ModAgentsLayout, ModKeyBinding, ModTerminalSource, UiModApi } from '@seti/mod-api'
import type { ModManifest } from '@seti/shared'
import { useMemo } from 'react'
import { chordAria, chordLabel, useChords } from '@/components/shortcuts/chords'
import { lazyView } from '@/panels/files/file-viewers'
import type { AgentsLayout } from '@/panels/tasks/agents-layouts'
import type { TerminalSource } from '@/panels/terminal/terminal-sources'
import { parseModChord } from './mod-chords'

type LayoutView = ModManifest['contributes']['views'][number]

/** A mod's layout as the Agents section's slot takes it, titled and placed by its manifest view. */
export function layoutOf(key: string, view: LayoutView, layout: ModAgentsLayout): AgentsLayout {
  return {
    key,
    title: view.title,
    icon: layout.icon,
    active: layout.active,
    setActive: layout.setActive,
    hint: layout.hint,
    phone: view.phone,
    view: lazyView(layout.view),
    shows: layout.shows,
    subscribe: layout.subscribe,
    shownAgents: layout.shownAgents,
    acceptsAgents: layout.acceptsAgents,
    overlay: layout.overlay,
    ...(layout.adoptTerminal === undefined ? {} : { adoptTerminal: layout.adoptTerminal }),
    ...(layout.newTerminal === undefined ? {} : { newTerminal: layout.newTerminal }),
    ...(layout.showWorkspace === undefined ? {} : { showWorkspace: layout.showWorkspace }),
  }
}

/** A mod's terminal source as the terminal list takes it. */
export function terminalSourceOf(key: string, source: ModTerminalSource): TerminalSource {
  const { label, list, subscribe, refresh, close, rename } = source
  return { key, label, list, subscribe, close, rename, ...(refresh === undefined ? {} : { refresh }) }
}

/** Binds keys a mod's view takes while it shows, written as in the manifest. */
function useModKeys(bindings: readonly ModKeyBinding[]): void {
  const parsed = useMemo(() => bindings.map(({ chord, run }) => ({ chord: parseModChord(chord), run })), [bindings])
  useChords(parsed)
}

/** Keys for mods: views bind chords while they show, and name them as this device does. */
export const MOD_KEYS: UiModApi['keys'] = {
  useChords: useModKeys,
  label: (chord) => chordLabel(parseModChord(chord)),
  aria: (chord) => chordAria(parseModChord(chord)),
}
