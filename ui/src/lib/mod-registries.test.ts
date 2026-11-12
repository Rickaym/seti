import { FlaskConical } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { aboutParts, headerViews, newsEntries } from '@/lib/mod-views'
import { digitSections, isSectionKey, sectionGroups, sectionRegistry } from '@/lib/sections'
import { isSettingsPage, settingsGroups, settingsPages } from '@/panels/settings/pages'

const View = () => null

describe('the registries mods add to', () => {
  it("hold Seti's own sections, and a mod's section joins the Mods group with no digit", () => {
    expect(sectionGroups().map((group) => group.group)).toEqual(['Work', 'Configure'])
    expect(sectionGroups()[0]?.items.map((item) => item.key)).toEqual(['ea', 'home', 'agents', 'questions'])
    expect(digitSections()).toEqual([
      { key: 'ea', digit: 1 },
      { key: 'home', digit: 2 },
      { key: 'agents', digit: 3 },
      { key: 'context', digit: 4 },
      { key: 'settings', digit: 5 },
    ])
    const dispose = sectionRegistry.register({
      key: 'sample.home',
      label: 'Sample',
      icon: FlaskConical,
      group: 'Mods',
      digit: null,
      view: View,
    })
    expect(isSectionKey('sample.home')).toBe(true)
    expect(sectionGroups().at(-1)).toMatchObject({ group: 'Mods', items: [{ key: 'sample.home' }] })
    expect(() =>
      sectionRegistry.register({ key: 'agents', label: 'Mine', icon: FlaskConical, group: 'Mods', digit: null }),
    ).toThrow()
    dispose()
    expect(isSectionKey('sample.home')).toBe(false)
    expect(digitSections()).toHaveLength(5)
  })

  it("hold Seti's settings pages with Mods last, and a mod's page joins that group", () => {
    const groups = settingsGroups()
    expect(groups.map((group) => group.group)).toEqual(['App', 'Agents', 'Claude Code', 'Security', 'Mods'])
    expect(groups.at(-1)?.pages.map((page) => page.key)).toEqual(['mods'])
    const dispose = settingsPages.register({
      key: 'sample.settings',
      label: 'Sample',
      icon: FlaskConical,
      group: 'Mods',
      view: View,
    })
    expect(isSettingsPage('sample.settings')).toBe(true)
    expect(
      settingsGroups()
        .at(-1)
        ?.pages.map((page) => page.key),
    ).toEqual(['mods', 'sample.settings'])
    dispose()
    expect(isSettingsPage('sample.settings')).toBe(false)
  })

  it('list About only while a mod adds a part to it, and put news on the page it is on', () => {
    const appPages = () => settingsGroups()[0]?.pages.map((page) => page.key)
    expect(appPages()).toEqual(['general', 'notifications', 'ea'])
    expect(isSettingsPage('about')).toBe(false)
    let unseen = false
    const disposers = [
      aboutParts.register({ key: 'sample.changes', name: 'Changes', view: View }),
      headerViews.register({ key: 'sample.band', name: 'Band', view: View }),
      newsEntries.register({
        key: 'sample.changes',
        page: 'about',
        news: { subscribe: () => () => undefined, get: () => unseen },
      }),
    ]
    expect(appPages()).toEqual(['general', 'notifications', 'ea', 'about'])
    expect(headerViews.list().map((view) => view.key)).toEqual(['sample.band'])
    expect(newsEntries.list().filter((entry) => entry.news.get())).toEqual([])
    unseen = true
    expect(newsEntries.list().map((entry) => entry.page)).toEqual(['about'])
    for (const dispose of disposers) {
      dispose()
    }
    expect(isSettingsPage('about')).toBe(false)
    expect(headerViews.list()).toEqual([])
  })
})
