import type { UiModApi } from '@seti/mod-api'
import { modScoped, type Disposer, type ModManifest } from '@seti/shared'
import { apiPost, apiPostStream, apiRequest } from '@/api'
import { COMMAND_PREFIX, openPalette } from '@/components/palette/palette-store'
import { isTyping } from '@/components/shortcuts/chords'
import { chatSearchIn } from '@/components/shortcuts/find'
import { setLandingArea, skipLanding } from '@/components/shortcuts/landing'
import { statusBarItems } from '@/components/status-bar/items'
import { toggleGroupChat } from '@/components/team/team-context'
import { mediaSignal, NARROW_QUERY } from '@/hooks/useMedia'
import { fenceRenderers } from '@/lib/fence-renderers'
import { inputHooks } from '@/lib/input-hooks'
import { aboutParts, headerViews, newsEntries } from '@/lib/mod-views'
import {
  composerOf,
  isPassthrough,
  markActivePanel,
  overlayOpen,
  PANEL,
  PANEL_PASSTHROUGH,
  panelActions,
  panelBeside,
  panelFocused,
  panelOf,
  scrollerOf,
  scrollToBottom,
  searchFieldOf,
  selectedPanel,
  visiblePanels,
} from '@/lib/panels'
import { startPolling } from '@/lib/poll-loop'
import { createPolledResource } from '@/lib/polled'
import { prChips } from '@/lib/pr-chips'
import { sectionRegistry } from '@/lib/sections'
import { readEvents } from '@/lib/sse'
import { agentAccents, statusMarkers } from '@/lib/status-markers'
import { transcriptBlockSources } from '@/lib/transcript-blocks'
import { fileViewers, lazyView } from '@/panels/files/file-viewers'
import { modSettingsKey } from '@/panels/settings/mods/mod-settings-key'
import { settingsPages } from '@/panels/settings/pages'
import { agentDocks, closeAgentDock, openAgentDock } from '@/panels/tasks/agent-docks'
import { agentsLayouts } from '@/panels/tasks/agents-layouts'
import { stepOwnMessages } from '@/panels/tasks/own-steps'
import { terminalSources } from '@/panels/terminal/terminal-sources'
import { MOD_AGENTS, MOD_TERMINALS } from './agent-parts'
import { callModAction, uiCommands } from './commands'
import { MOD_KIT } from './kit'
import { layoutOf, MOD_KEYS, terminalSourceOf } from './layout-parts'
import { saveModSettings, useModSettings } from './mod-settings'
import type { ModSwitches } from './switches'

const POLL_MIN_MS = 10_000

const PANELS: UiModApi['panels'] = {
  panelOf,
  visible: visiblePanels,
  beside: panelBeside,
  scrollerOf,
  scrollToBottom,
  composerOf,
  searchFieldOf,
  actionsOf: panelActions,
  isPassthrough,
  overlayOpen,
  selected: selectedPanel,
  markActive: markActivePanel,
  findOf: chatSearchIn,
  markers: { PANEL, PANEL_PASSTHROUGH, focused: panelFocused },
  setLandingArea,
}

const APP: UiModApi['app'] = {
  narrow: mediaSignal(NARROW_QUERY),
  isTyping,
  openCommands: () => {
    openPalette(COMMAND_PREFIX)
  },
  toggleGroupChat,
  stepOwnMessages,
  holdFocus: skipLanding,
  every: (run, intervalMs) => startPolling(run, intervalMs),
}

/** Seti's agents for one mod's UI half, with its docks by their local id and messages as the user. */
function agentsOf(id: string, manifest: ModManifest): UiModApi['agents'] {
  const dockKey = (dock: string) => {
    const docks = manifest.contributes.views.filter((view) => view.where === 'agentDock')
    declared(docks, dock, manifest)
    return modScoped(id, dock)
  }
  return {
    ...MOD_AGENTS,
    send: async (agent, prompt) => {
      await apiPost(`/tasks/${encodeURIComponent(agent)}/messages`, { prompt })
    },
    openDock: (agent, dock) => {
      openAgentDock(agent, dockKey(dock))
    },
    closeDock: (agent, dock) => {
      closeAgentDock(agent, dockKey(dock))
    },
  }
}

function declared<T extends { id: string }>(entries: readonly T[], id: string, manifest: ModManifest): T {
  const entry = entries.find((candidate) => candidate.id === id)
  if (entry === undefined) {
    throw new Error(`${manifest.name} registers ${id}, which its manifest does not declare`)
  }
  return entry
}

function declaredFence<T extends { language: string }>(entries: readonly T[], language: string, manifest: ModManifest) {
  const entry = entries.find((candidate) => candidate.language === language)
  if (entry === undefined) {
    throw new Error(`${manifest.name} draws ${language} fences, which its manifest does not declare`)
  }
  return entry
}

/** How the host follows what a mod's UI half registers. */
interface UiApiHooks {
  track: (dispose: Disposer) => Disposer
  ownPage: () => void
  /** Registrations a setting turns on and off while the mod runs. */
  switches: ModSwitches
}

/** The UI half's API: each id must name what the manifest declares, and every call is tracked. */
export function uiApi(manifest: ModManifest, { track, ownPage, switches }: UiApiHooks): UiModApi {
  const { id, contributes } = manifest
  const switched = (setting: string | undefined, register: () => Disposer) =>
    track(setting === undefined ? register() : switches.add(setting, register))
  const placed = (where: string) => contributes.views.filter((view) => view.where === where)
  const useSettings = () => useModSettings(manifest)
  return {
    id,
    manifest,
    registerSection: ({ id: view, icon, view: View }) => {
      const { title } = declared(placed('section'), view, manifest)
      const key = modScoped(id, view)
      return track(sectionRegistry.register({ key, label: title, icon, group: 'Mods', digit: null, view: View }))
    },
    registerDock: ({ id: dock, icon, view, onClose }) => {
      const { title, description } = declared(placed('agentDock'), dock, manifest)
      const key = modScoped(id, dock)
      const entry = { key, title, description: description ?? null, icon, view, onClose: onClose ?? null }
      return track(agentDocks.register(entry))
    },
    registerView: ({ id: view, view: View }) => {
      const { title, where } = declared([...placed('header'), ...placed('about')], view, manifest)
      const registry = where === 'header' ? headerViews : aboutParts
      return track(registry.register({ key: modScoped(id, view), name: title, view: View }))
    },
    registerNews: ({ view, news }) => {
      declared(placed('about'), view, manifest)
      return track(newsEntries.register({ key: modScoped(id, view), page: 'about', news }))
    },
    registerSettingsPage: ({ icon, keywords, view }) => {
      ownPage()
      const page = { key: modSettingsKey(id), label: manifest.name, icon, group: 'Mods' as const, view }
      return track(settingsPages.register(keywords === undefined ? page : { ...page, keywords }))
    },
    registerStatusBarItem: ({ id: item, view }) => {
      const { title } = declared(contributes.statusBar, item, manifest)
      return track(statusBarItems.register({ key: modScoped(id, item), name: title, slot: 'work', view }))
    },
    registerFileViewer: (given) => {
      const { id: viewer, maxBytes, setting, ...entry } = declared(contributes.fileViewers, given.id, manifest)
      const registered = { ...entry, key: modScoped(id, viewer), maxBytes: maxBytes ?? null, view: lazyView(given) }
      return switched(setting, () => fileViewers.register(registered))
    },
    registerFenceRenderer: (given) => {
      const { language, setting } = declaredFence(contributes.fenceRenderers, given.language, manifest)
      const entry = { language, view: lazyView(given), snapshot: given.snapshot ?? null }
      return switched(setting, () => fenceRenderers.register(entry))
    },
    registerPrChip: ({ id: chip, view }) => {
      const { title } = declared(contributes.prChips, chip, manifest)
      return track(prChips.register({ key: modScoped(id, chip), name: title, view }))
    },
    registerStatusMarker: ({ id: marker, view }) => {
      const { title } = declared(contributes.statusMarkers, marker, manifest)
      return track(statusMarkers.register({ key: modScoped(id, marker), name: title, view }))
    },
    registerAgentAccent: ({ id: accent, view }) => {
      const { title } = declared(contributes.agentAccents, accent, manifest)
      return track(agentAccents.register({ key: modScoped(id, accent), name: title, view }))
    },
    registerTranscriptBlocks: (source) => {
      const { title } = declared(contributes.transcriptBlocks, source.id, manifest)
      return track(transcriptBlockSources.register({ key: modScoped(id, source.id), mod: id, name: title, source }))
    },
    registerCommand: ({ id: command, icon, run, when, title, waits, status }) => {
      declared(contributes.commands, command, manifest)
      const key = modScoped(id, command)
      const ui = { run: run ?? null, when: when ?? null, title: title ?? null, waits: waits ?? null }
      return track(uiCommands.register({ key, icon: icon ?? null, status: status ?? null, ...ui }))
    },
    runCommand: async (command, args = {}) => {
      declared(contributes.commands, command, manifest)
      return callModAction(id, command, args)
    },
    registerInputHook: ({ id: hook, ...handlers }) => {
      declared(contributes.inputHooks, hook, manifest)
      return track(inputHooks.register({ key: modScoped(id, hook), ...handlers }))
    },
    registerAgentsLayout: (layout) => {
      const view = declared(placed('agentsLayout'), layout.id, manifest)
      return track(agentsLayouts.register(layoutOf(modScoped(id, layout.id), view, layout)))
    },
    registerTerminalSource: (source) =>
      track(terminalSources.register(terminalSourceOf(modScoped(id, source.id), source))),
    panels: PANELS,
    app: APP,
    agents: agentsOf(id, manifest),
    terminals: MOD_TERMINALS,
    keys: MOD_KEYS,
    request: async (method, path, body) => apiRequest(method, `/mods/${id}${path}`, body),
    stream: async (path, body, onEvent, signal) =>
      readEvents(await apiPostStream(`/mods/${id}${path}`, body, signal), onEvent),
    poll: (path, intervalMs) => createPolledResource(`/mods/${id}${path}`, Math.max(intervalMs, POLL_MIN_MS)),
    useSettings,
    saveSettings: async (values) => saveModSettings(id, values),
    kit: MOD_KIT,
    onDispose: (dispose) => {
      track(dispose)
    },
  }
}
