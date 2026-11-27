import type { ModSignal, ModViewProps } from '@seti/mod-api'
import { Registry } from '@seti/shared'
import { useSyncExternalStore, type ComponentType } from 'react'

interface PlacedView {
  key: string
  /** What its error boundary calls it when it crashes. */
  name: string
  view: ComponentType<ModViewProps>
}

/** The bands across the app header that enabled mods add; without one the header keeps its gap. */
export const headerViews = new Registry<PlacedView>('header view', (view) => view.key)

/** The parts of Settings, About that enabled mods add; About is listed only while one does. */
export const aboutParts = new Registry<PlacedView>('about part', (view) => view.key)

/** The views enabled mods add under the sidebar's sections, in the rail and the menu drawer. */
export const navBottomViews = new Registry<PlacedView>('navigation view', (view) => view.key)

export const usePlacedViews = (registry: Registry<PlacedView>): readonly PlacedView[] =>
  useSyncExternalStore(registry.subscribe, registry.list)

/** Whether an enabled mod places a view under the sidebar's sections, so the sections give way. */
export const useNavBottomViews = () => usePlacedViews(navBottomViews).length > 0

const NAV_PANEL_KEY = 'seti.nav-panel'
const panelListeners = new Set<() => void>()

function storedPanel(): string | null {
  try {
    return localStorage.getItem(NAV_PANEL_KEY)
  } catch {
    return null
  }
}

let openPanel = storedPanel()

/** Opens a `navBottom` view's panel beside the rail, or closes it with null; this device keeps it. */
export function setNavPanel(key: string | null): void {
  openPanel = key
  try {
    if (key === null) {
      localStorage.removeItem(NAV_PANEL_KEY)
    } else {
      localStorage.setItem(NAV_PANEL_KEY, key)
    }
  } catch {
    // Without storage the panel stays open for this page only.
  }
  for (const listener of panelListeners) {
    listener()
  }
}

const subscribePanel = (listener: () => void) => {
  panelListeners.add(listener)
  return () => {
    panelListeners.delete(listener)
  }
}

/** The key of the `navBottom` view whose panel is open beside the rail, or null. */
export const useNavPanel = (): string | null => useSyncExternalStore(subscribePanel, () => openPanel)

interface NewsEntry {
  key: string
  /** The settings page the news is on. */
  page: string
  news: ModSignal
}

/** What a control with a news dot adds to its name for screen readers. */
export const NEWS_DESCRIPTION = 'New in Seti since you last looked'

/** News a mod has for the user, which puts a dot on Settings and on the page it is on. */
export const newsEntries = new Registry<NewsEntry>('news', (entry) => entry.key)

function subscribeNews(listener: () => void): () => void {
  let inner: (() => void)[] = []
  const follow = () => {
    for (const stop of inner) {
      stop()
    }
    inner = newsEntries.list().map((entry) => entry.news.subscribe(listener))
  }
  follow()
  const outer = newsEntries.subscribe(() => {
    follow()
    listener()
  })
  return () => {
    outer()
    for (const stop of inner) {
      stop()
    }
  }
}

let newsPages: readonly string[] = []

function newsSnapshot(): readonly string[] {
  const pages = newsEntries.list().flatMap((entry) => (entry.news.get() ? [entry.page] : []))
  if (pages.join('\n') !== newsPages.join('\n')) {
    newsPages = pages
  }
  return newsPages
}

/** The settings pages with news waiting; their ways in carry a dot. */
export function useNewsPages(): readonly string[] {
  return useSyncExternalStore(subscribeNews, newsSnapshot)
}
