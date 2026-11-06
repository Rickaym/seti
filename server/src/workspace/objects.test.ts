import type { Revision } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { parseFrontMatter, renderFrontMatter } from './front-matter.js'
import { assignSlugs, insertNote, parseContextFile, parsePack, renderPack, slugify } from './objects.js'

const note = (reason: string, at = '2026-09-29T10:00:00.000Z'): Revision => ({
  id: 1,
  at,
  actor: 'agent',
  task_id: 't',
  task_title: 'Deploy fixer',
  object_type: 'context_pack',
  object_id: 'p',
  kind: 'note',
  before: null,
  after: null,
  reason,
})

describe('front matter', () => {
  it('round-trips text, booleans and lists, quoting what needs it', () => {
    const front = {
      name: 'Deploy notes',
      description: 'Says: "hi", then [waves]',
      linked: true,
      packs: ['a', 'b,c'],
      empty: '',
    }
    const text = `${renderFrontMatter(front)}\nbody`
    expect(text).toContain('description: "Says: \\"hi\\", then [waves]"')
    expect(parseFrontMatter(text)).toEqual({ front, body: 'body' })
  })

  it('explains malformed front matter', () => {
    expect(() => parseFrontMatter('name: x')).toThrow('must start with a --- front matter line')
    expect(() => parseFrontMatter('---\nname: x\n')).toThrow('no closing ---')
    expect(() => parseFrontMatter('---\njust text\n---\n')).toThrow('"just text" is not a key: value line')
    expect(() => parseFrontMatter('---\npacks: [a, b\n---\n')).toThrow('no closing ]')
  })
})

describe('slugs', () => {
  it('names files after items and numbers clashes in list order', () => {
    expect(slugify('Deploy -- Notes!', 'pack')).toBe('deploy-notes')
    expect(slugify('***', 'pack')).toBe('pack')
    const slugs = assignSlugs(
      [
        { id: '1', name: 'Style' },
        { id: '2', name: 'style' },
        { id: '3', name: 'STYLE' },
      ],
      'pack',
    )
    expect([...slugs.entries()].map(([slug, item]) => [slug, item.id])).toEqual([
      ['style', '1'],
      ['style-2', '2'],
      ['style-3', '3'],
    ])
  })
})

describe('pack files', () => {
  const view = {
    pack: {
      name: 'Deploy notes',
      description: 'How we ship',
      body: 'Run make deploy.\n\n## Notes\nnot ours',
      kind: 'reference' as const,
    },
    linked: false,
    notes: [note('Asked to add the rollback step')],
  }

  it('renders front matter, the body and the notes section', () => {
    const text = renderPack(view)
    expect(text).toMatch(/^---\nname: Deploy notes\ndescription: How we ship\nlinked: false\n---\n\nRun make deploy/)
    expect(text).toContain('- 2026-09-29 agent (Deploy fixer): Asked to add the rollback step')
  })

  it('parses its own rendering back without changes or notes', () => {
    expect(parsePack(renderPack(view), view.notes)).toEqual({
      name: 'Deploy notes',
      description: 'How we ship',
      kind: undefined,
      linked: false,
      reason: undefined,
      body: view.pack.body,
      note: null,
    })
  })

  it('reads edits, the reason, the link and a new note line, dropping Seti notes', () => {
    const edited = insertNote(
      renderPack(view)
        .replace('linked: false', 'linked: true\nreason: "user said: add rollback"')
        .replace('Run make deploy.', 'Run make deploy, then make verify.')
        .concat('- Added verify step\n'),
      'earlier rejection',
    )
    expect(edited).toContain('<!-- seti: rejected: earlier rejection -->')
    const parsed = parsePack(edited, view.notes)
    expect(parsed).toMatchObject({ linked: true, reason: 'user said: add rollback', note: 'Added verify step' })
    expect(parsed.body).toBe('Run make deploy, then make verify.\n\n## Notes\nnot ours')
  })

  it('refuses unknown keys and takes a file without front matter as an error', () => {
    expect(() => parsePack('---\nname: x\ncolour: red\n---\nbody', [])).toThrow('unknown front matter colour')
    expect(() => parsePack('just a body', [])).toThrow('front matter')
  })

  it('writes kind: role only on role packs and reads the kind back', () => {
    const role = renderPack({ ...view, pack: { ...view.pack, name: 'Release lead', kind: 'role' } })
    expect(role).toMatch(/^---\nname: Release lead\ndescription: How we ship\nkind: role\nlinked: false\n---/)
    expect(parsePack(role, view.notes).kind).toBe('role')
    expect(() => parsePack('---\nname: x\nkind: boss\n---\nbody', [])).toThrow('kind is reference or role, not boss')
  })
})

describe('notes and context files', () => {
  it('puts a rejection note below front matter, or on top without it, replacing an older one', () => {
    expect(insertNote('---\na: b\n---\nbody', 'bad')).toBe('---\na: b\n---\n<!-- seti: rejected: bad -->\nbody\n')
    const once = insertNote('# Rules\n---\nmore', 'first')
    expect(insertNote(once, 'second')).toBe('<!-- seti: rejected: second -->\n# Rules\n---\nmore\n')
    expect(parseContextFile(once)).toBe('# Rules\n---\nmore\n')
  })
})
