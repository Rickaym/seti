import { PACK_KINDS, type ContextPack, type PackKind, type Revision } from '@seti/shared'
import { frontBoolean, frontString, parseFrontMatter, renderFrontMatter, type FrontMatter } from './front-matter.js'

const SLUG_MAX = 60
const NOTE_CHARS = 200

/** A file name for a pack: its name lowercased with dashes. */
export function slugify(name: string, fallback: string): string {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]/)
    .filter((word) => word !== '')
  const slug = words.join('-').slice(0, SLUG_MAX)
  const trimmed = slug.endsWith('-') ? slug.slice(0, -1) : slug
  return trimmed === '' ? fallback : trimmed
}

/** Gives every item its own slug, in list order; a taken slug gets -2, -3 and so on. */
export function assignSlugs<T extends { id: string; name: string }>(items: readonly T[], fallback: string) {
  const bySlug = new Map<string, T>()
  for (const item of items) {
    const base = slugify(item.name, fallback)
    let slug = base
    let n = 1
    while (bySlug.has(slug)) {
      n += 1
      slug = `${base}-${String(n)}`
    }
    bySlug.set(slug, item)
  }
  return bySlug
}

/** The slug an item got from assignSlugs, or null when it has none. */
export const slugOf = <T extends { id: string }>(slugs: ReadonlyMap<string, T>, id: string) =>
  [...slugs.entries()].find(([, item]) => item.id === id)?.[0] ?? null

const NOTES_HEADING = '## Notes'
const NOTES_MARKER = '<!-- seti: add a line below to note in the history what you changed and why -->'
const SETI_NOTE = /^<!-- seti: .* -->$/

/** A rejection note that the next read of the file shows and the next parse drops. */
export const rejectionLine = (reason: string) => `<!-- seti: rejected: ${reason.replace(/-->/g, '- ->')} -->`

const dropSetiLines = (text: string) =>
  text
    .split('\n')
    .filter((line) => !SETI_NOTE.test(line.trim()) || line.trim() === NOTES_MARKER)
    .join('\n')

const noteLine = (revision: Revision) => {
  const text = (revision.reason ?? '').replace(/\s+/g, ' ').trim()
  const clipped = text.length <= NOTE_CHARS ? text : `${text.slice(0, NOTE_CHARS - 3)}...`
  const task = revision.task_title === null ? '' : ` (${revision.task_title})`
  const who = revision.actor === 'agent' ? `agent${task}` : 'user'
  return `- ${revision.at.slice(0, 10)} ${who}: ${clipped}`
}

function notesSection(notes: readonly Revision[]): string {
  return [NOTES_HEADING, NOTES_MARKER, ...notes.toReversed().map(noteLine)].join('\n')
}

/** The body above the notes section, and the note lines below its marker. */
function splitNotes(body: string): { text: string; notes: string[] } {
  const lines = body.split('\n')
  const marker = lines.findIndex(
    (line, index) => line.trim() === NOTES_MARKER && lines[index - 1]?.trim() === NOTES_HEADING,
  )
  if (marker === -1) {
    return { text: body, notes: [] }
  }
  return {
    text: lines.slice(0, marker - 1).join('\n'),
    notes: lines
      .slice(marker + 1)
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  }
}

/** Note lines the agent added, joined into one note; null when it added none. */
function addedNote(notes: readonly string[], rendered: readonly Revision[]): string | null {
  const known = new Set(rendered.map(noteLine))
  const added = notes
    .filter((line) => !known.has(line))
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter((line) => line !== '')
  return added.length === 0 ? null : added.join('\n')
}

function withNote(file: string, note: string | null): string {
  if (note === null) {
    return file
  }
  const end = file.startsWith('---\n') ? file.indexOf('\n---\n') : -1
  return end === -1 ? `${note}\n${file}` : `${file.slice(0, end + 5)}${note}\n${file.slice(end + 5)}`
}

/** Puts a rejection note right below the front matter, or on top when there is none. */
export const insertNote = (text: string, reason: string) =>
  `${withNote(dropSetiLines(text), rejectionLine(reason)).trimEnd()}\n`

const joinFile = (front: string, text: string, notes: readonly Revision[]) =>
  `${front}\n\n${text.trim()}\n\n${notesSection(notes)}\n`

export interface PackView {
  pack: Pick<ContextPack, 'name' | 'description' | 'body' | 'kind'>
  linked: boolean
  notes: readonly Revision[]
}

export const renderPack = ({ pack, linked, notes }: PackView) =>
  joinFile(
    renderFrontMatter({
      name: pack.name,
      description: pack.description,
      ...(pack.kind === 'role' ? { kind: pack.kind } : {}),
      linked,
    }),
    pack.body,
    notes,
  )

/** What the agent wants a pack to be; fields are undefined when the file leaves them out. */
export interface PackEdit {
  name: string | undefined
  description: string | undefined
  kind: PackKind | undefined
  linked: boolean | undefined
  reason: string | undefined
  body: string
  note: string | null
}

function frontKind(front: FrontMatter): PackKind | undefined {
  const kind = frontString(front, 'kind')
  if (kind === undefined) {
    return undefined
  }
  const known = PACK_KINDS.find((entry) => entry === kind)
  if (known === undefined) {
    throw new Error(`kind is reference or role, not ${kind}`)
  }
  return known
}

export function parsePack(text: string, rendered: readonly Revision[]): PackEdit {
  const { front, body } = parseFrontMatter(dropSetiLines(text))
  const { text: main, notes } = splitNotes(body)
  const known = new Set(['name', 'description', 'kind', 'linked', 'reason'])
  const unknown = Object.keys(front).filter((key) => !known.has(key))
  if (unknown.length > 0) {
    throw new Error(`unknown front matter ${unknown.join(', ')}; packs take name, description, kind, linked and reason`)
  }
  return {
    name: frontString(front, 'name'),
    description: frontString(front, 'description'),
    kind: frontKind(front),
    linked: frontBoolean(front, 'linked'),
    reason: frontString(front, 'reason'),
    body: main.trim(),
    note: addedNote(notes, rendered),
  }
}

/** A context file's content as the agent wrote it, without Seti's notes. */
export const parseContextFile = (text: string) => dropSetiLines(text)
