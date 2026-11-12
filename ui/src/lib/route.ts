import { filesLinkOfHash, type FilesLink } from '@seti/shared'
import { mayLeave } from '@/lib/leave-guard'
import { isSectionKey, LANDING_SECTION, type SectionKey } from '@/lib/sections'

export interface Route {
  section: SectionKey
  id: string | null
  /** A subtask of the task in `id`, from `#agents/<id>/sub/<tool use id>`. */
  sub: string | null
  /** What a settings page shows, from `#settings/<page>/<detail>`. */
  detail: string | null
  /** A terminal shown alone, from `#agents/terminal/<terminal id>`; `id` is then `terminal`. */
  terminal: string | null
}

/** The id in `#agents/<id>` that opens a terminal alone; agent ids are UUIDs, so never this. */
export const TERMINAL_ROUTE = 'terminal'

const parts = (hash: string) => hash.replace(/^#\/?/, '').split('/')

export function parseHash(): Route {
  const [section = '', id = '', child = '', sub = '', ...rest] = parts(window.location.hash)
  const key = isSectionKey(section) ? section : LANDING_SECTION
  const detail = [child, sub, ...rest].filter((part) => part !== '').join('/')
  return {
    section: key,
    id: id === '' ? null : id,
    sub: child === 'sub' && sub !== '' ? sub : null,
    detail: key === 'settings' && detail !== '' ? detail : null,
    terminal: key === 'agents' && id === TERMINAL_ROUTE && child !== '' ? child : null,
  }
}

let previousHash: string | null = null
let currentHash = window.location.hash

/** The card a redirected old link points at, kept until the hash changes again. */
let card: string | null = null

const DEPTH_KEY = 'setiDepth'

/** How many of Seti's own history entries lie behind the one whose state this is, if stamped. */
function depthOf(state: unknown): number | null {
  if (typeof state !== 'object' || state === null) {
    return null
  }
  const depth = (state as Record<string, unknown>)[DEPTH_KEY]
  return typeof depth === 'number' ? depth : null
}

function stampDepth(depth: number): void {
  const state: unknown = window.history.state
  const kept = typeof state === 'object' && state !== null ? state : {}
  window.history.replaceState({ ...kept, [DEPTH_KEY]: depth }, '')
}

let depth = depthOf(window.history.state) ?? 0
if (depthOf(window.history.state) === null) {
  stampDepth(depth)
}

window.addEventListener('hashchange', () => {
  previousHash = currentHash
  currentHash = window.location.hash
  card = null
  const stamped = depthOf(window.history.state)
  if (stamped === null) {
    depth += 1
    stampDepth(depth)
  } else {
    depth = stamped
  }
})

/** The id of the card an old link to a merged page meant, such as the SSH hosts card. */
export const movedCard = () => card

/** Sections that became settings pages, and the page each one opens. */
const MOVED: Partial<Record<string, string>> = { capabilities: 'mcp', repos: 'repos', audit: 'audit' }

/** Where a moved settings page or part lives: its page, the prefix of a detail under it, a card. */
interface Moved {
  page: string
  under?: string
  card?: string
}

const SSH_HOSTS: Moved = { page: 'ssh', card: 'ssh-hosts' }
const SSH_KEYS: Moved = { page: 'ssh', under: 'keys', card: 'ssh-keys' }
const PHONES: Moved = { page: 'signin', card: 'phones' }
const SECRETS: Moved = { page: 'credentials', card: 'secrets' }

/** Parts of settings pages that became pages of their own, by their old `<page>/<part>` path. */
const MOVED_PARTS: Partial<Record<string, string | Moved>> = {
  'general/preferences': 'general',
  'general/notifications': 'notifications',
  'general/repos': 'repos',
  'general/about': 'about',
  'plugins/skills': 'skills',
  'plugins/subagents': 'subagents',
  'signin/browsers': 'signin',
  'signin/devices': PHONES,
  'credentials/sets': 'credentials',
  'credentials/secrets': SECRETS,
  'credentials/hosts': SSH_HOSTS,
  'credentials/keys': SSH_KEYS,
}

/** Settings pages merged into another, by their old key. */
const MERGED_PAGES: Partial<Record<string, Moved>> = {
  'ssh-hosts': SSH_HOSTS,
  'ssh-keys': SSH_KEYS,
  'whats-new': { page: 'about', card: 'changes' },
  devices: PHONES,
  secrets: SECRETS,
}

interface Target {
  hash: string
  card: string | null
}

function settingsTarget(moved: string | Moved, tail: string[]): Target {
  const { page, under, card: to } = typeof moved === 'string' ? { page: moved } : moved
  if (tail.length === 0) {
    return { hash: ['settings', page].join('/'), card: to ?? null }
  }
  return { hash: ['settings', page, ...(under === undefined ? [] : [under]), ...tail].join('/'), card: null }
}

/** Where an old `#tasks`, `#prs` or moved settings hash such as `#repos` lives now, or null. */
function movedTarget(hash: string): Target | null {
  const [section = '', ...rest] = parts(hash)
  if (section === 'tasks') {
    return { hash: ['agents', ...rest].join('/'), card: null }
  }
  if (section === 'prs') {
    return { hash: 'agents', card: null }
  }
  if (section === 'settings') {
    const pieces = rest.filter((piece) => piece !== '')
    const [page = '', part = '', ...tail] = pieces
    const moved = MOVED_PARTS[`${page}/${part}`]
    if (moved !== undefined) {
      return settingsTarget(moved, tail)
    }
    const merged = MERGED_PAGES[page]
    return merged === undefined ? null : settingsTarget(merged, pieces.slice(1))
  }
  const page = MOVED[section]
  if (page === undefined) {
    return null
  }
  const tail = section === 'audit' ? rest.filter((part) => part !== '') : []
  return { hash: ['settings', page, ...tail].join('/'), card: null }
}

/** The Files deep link the hash named before it became its agent's hash, until taken. */
let filesLink: FilesLink | null = null

/** The file or folder a followed Files deep link asked to open, handed over once. */
export function takeFilesLink(): FilesLink | null {
  const link = filesLink
  filesLink = null
  return link
}

/** Replaces an old section hash with where it lives now, leaving no history entry behind. */
export function redirectMovedHash(): void {
  const link = filesLinkOfHash(window.location.hash)
  if (link !== null) {
    window.history.replaceState(window.history.state, '', `#agents/${encodeURIComponent(link.task_id)}`)
    currentHash = window.location.hash
    filesLink = link
    return
  }
  const target = movedTarget(window.location.hash)
  if (target !== null) {
    window.history.replaceState(window.history.state, '', `#${target.hash}`)
    currentHash = window.location.hash
    card = target.card
  }
}

const sectionOf = (hash: string): SectionKey => {
  const [section = ''] = parts(hash)
  return isSectionKey(section) ? section : LANDING_SECTION
}

const isList = (hash: string) => (parts(hash)[1] ?? '') === ''

/** Leaves a detail for its section's list: a history step back when the list led here. */
export function goUp(section: SectionKey) {
  const cameFromList = previousHash !== null && sectionOf(previousHash) === section && isList(previousHash)
  if (cameFromList && sectionOf(currentHash) === section) {
    void mayLeave().then((ok) => {
      if (ok) {
        window.history.back()
      }
    })
    return
  }
  navigate(section)
}

/** Steps back to where the user was in Seti, or opens the section's list when Seti opened here. */
export function goBack(section: SectionKey) {
  if (depth === 0) {
    navigate(section)
    return
  }
  void mayLeave().then((ok) => {
    if (ok) {
      window.history.back()
    }
  })
}

/** Changes the hash after any leave guard agrees; `force` skips guards after a save or delete. */
export function navigate(section: SectionKey, id?: string, { force = false }: { force?: boolean } = {}) {
  const hash = id === undefined ? section : `${section}/${id}`
  if (force) {
    window.location.hash = hash
    return
  }
  void mayLeave().then((ok) => {
    if (ok) {
      window.location.hash = hash
    }
  })
}
