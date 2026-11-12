import {
  agentColorWord,
  listedStatus,
  type AgentColor,
  type ArchivedTaskEntry,
  type ContextFile,
  type ContextPack,
  type PrList,
  type TaskDisplayStatus,
  type TaskListEntry,
} from '@seti/shared'
import { Archive, Bot, FileText, GitPullRequest, GitPullRequestDraft, Library, MessagesSquare } from 'lucide-react'
import type { ComponentType } from 'react'
import { chordLabel, sectionChord } from '@/components/shortcuts/chords'
import { TEAM_SHORTCUT } from '@/components/team/team-context'
import { sectionGroups, type SectionKey } from '@/lib/sections'
import { relativeTime } from '@/lib/time'
import { packSelection } from '@/panels/context/selection'
import { settingsGroups } from '@/panels/settings/pages'
import { repoLabel, shortRepoLabel } from '@/panels/tasks/agent-list'

export type PlaceKind = 'section' | 'settings' | 'agent' | 'archived' | 'pr' | 'context'

/** Somewhere the Go to palette can take the user, built from data the app already holds. */
export interface Place {
  /** Unique across kinds, such as `agent:<id>`; recents remember it. */
  id: string
  kind: PlaceKind
  title: string
  detail: string
  /** The full detail, as a tooltip, when `detail` shortens it. */
  detailTitle?: string
  icon: ComponentType<{ className?: string }>
  keywords?: string
  status?: TaskDisplayStatus | 'archived'
  /** An agent's colour, a stripe at the row's edge. */
  color?: AgentColor | null
  /** The key combination that also opens it, shown as a hint. */
  shortcut?: string
  /** A route to open, or an action for places that are not routes. */
  target: { section: SectionKey; id?: string } | { run: () => void }
}

/** Group titles in the order the palette lists them while the query is empty. */
export const PLACE_GROUPS: Record<PlaceKind, string> = {
  section: 'Sections',
  agent: 'Agents',
  archived: 'Archived agents',
  pr: 'Pull requests',
  context: 'Context',
  settings: 'Settings',
}

export function sectionPlaces(openGroupChat: () => void): Place[] {
  const routes = sectionGroups()
    .flatMap((group) => group.items.map((item) => ({ item, group: group.group })))
    .map(({ item, group }): Place => ({
      id: `section:${item.key}`,
      kind: 'section',
      title: item.label,
      detail: '',
      icon: item.icon,
      keywords: item.keywords === undefined ? group : `${group} ${item.keywords}`,
      ...(item.digit === null ? {} : { shortcut: chordLabel(sectionChord(item.digit)) }),
      target: { section: item.key },
    }))
  const chat: Place = {
    id: 'section:team',
    kind: 'section',
    title: 'Group chat',
    detail: '',
    icon: MessagesSquare,
    keywords: 'team messages',
    shortcut: TEAM_SHORTCUT,
    target: { run: openGroupChat },
  }
  return [...routes, chat]
}

/** Each settings page, under the name of its group; Mods is also found by the names of mods. */
export const settingsPlaces = (modNames = ''): Place[] =>
  settingsGroups().flatMap((group) =>
    group.pages.map((page): Place => ({
      id: `settings:${page.key}`,
      kind: 'settings',
      title: page.label,
      detail: `Settings, ${group.group}`,
      icon: page.icon,
      keywords: ['settings', page.keywords, page.key === 'mods' ? modNames : ''].filter(Boolean).join(' '),
      target: { section: 'settings', id: page.key },
    })),
  )

/** Pinned agents first, then the most recent; each names its folder and its last activity. */
export function agentPlaces(tasks: readonly TaskListEntry[], now: number = Date.now()): Place[] {
  return [...tasks]
    .sort((a, b) =>
      a.pinned === b.pinned ? b.updated_at.localeCompare(a.updated_at) : Number(b.pinned) - Number(a.pinned),
    )
    .map((task) => ({
      id: `agent:${task.id}`,
      kind: 'agent',
      title: task.title,
      detail: `${shortRepoLabel(task)}, ${relativeTime(task.updated_at, now)}`,
      detailTitle: repoLabel(task),
      icon: Bot,
      keywords: [repoLabel(task), task.pinned ? 'pinned' : '', agentColorWord(task.color)].filter(Boolean).join(' '),
      status: listedStatus(task),
      color: task.color,
      target: { section: 'agents', id: task.id },
    }))
}

export const archivedPlaces = (tasks: readonly ArchivedTaskEntry[]): Place[] =>
  tasks.map((task) => ({
    id: `agent:${task.id}`,
    kind: 'archived',
    title: task.title,
    detail: shortRepoLabel(task),
    detailTitle: repoLabel(task),
    icon: Archive,
    keywords: `${repoLabel(task)} archived`,
    status: 'archived',
    color: task.color,
    target: { section: 'agents', id: task.id },
  }))

export const prPlaces = (list: PrList | undefined): Place[] =>
  (list?.repos ?? []).flatMap((group) =>
    group.prs.map((pr) => ({
      id: `pr:${pr.key}`,
      kind: 'pr',
      title: pr.title,
      detail: `${pr.repo_slug}#${String(pr.number)}`,
      icon: pr.draft ? GitPullRequestDraft : GitPullRequest,
      keywords: [pr.author ?? '', pr.head_ref, pr.draft ? 'draft' : ''].join(' '),
      target: { run: () => window.open(pr.url, '_blank', 'noopener,noreferrer') },
    })),
  )

export function contextPlaces(files: readonly ContextFile[], packs: readonly ContextPack[]): Place[] {
  const filePlaces = files.map((file): Place => ({
    id: `context:${file.key}`,
    kind: 'context',
    title: file.label,
    detail: file.path,
    icon: FileText,
    keywords: file.group,
    target: { section: 'context', id: file.key },
  }))
  const packPlaces = packs.map((pack): Place => ({
    id: `context:${packSelection(pack.id)}`,
    kind: 'context',
    title: pack.name,
    detail: pack.description === '' ? 'Context pack' : pack.description,
    icon: Library,
    keywords: 'pack',
    target: { section: 'context', id: packSelection(pack.id) },
  }))
  return [...filePlaces, ...packPlaces]
}
