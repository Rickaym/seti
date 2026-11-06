import type { ModSignal } from '@seti/mod-api'
import { Registry } from '@seti/shared'
import { useSyncExternalStore, type ComponentType } from 'react'

interface PlacedView {
  key: string
  /** What its error boundary calls it when it crashes. */
  name: string
  view: ComponentType
}

/** The bands across the app header that enabled mods add; without one the header keeps its gap. */
export const headerViews = new Registry<PlacedView>('header view', (view) => view.key)

/** The parts of Settings, About that enabled mods add; About is listed only while one does. */
export const aboutParts = new Registry<PlacedView>('about part', (view) => view.key)

export const usePlacedViews = (registry: Registry<PlacedView>): readonly PlacedView[] =>
  useSyncExternalStore(registry.subscribe, registry.list)

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
