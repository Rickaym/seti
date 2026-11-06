import {
  claimFileViewers,
  disposeAll,
  isPageName,
  kindByName,
  modManifest,
  type Disposer,
  type ModInfo,
  type ModManifestInput,
} from '@seti/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { rendererFor, type FenceRendererEntry } from '@/lib/fence-renderers'
import { fileViewers, modShowing, viewerFor, type FileViewerEntry } from '@/panels/files/file-viewers'

const View = () => null

const PAGES: FileViewerEntry = {
  key: 'probe.pages',
  title: 'Pages',
  kinds: ['pdf'],
  extensions: [],
  text: false,
  page: false,
  maxBytes: null,
  source: false,
  whileEditing: false,
  phone: true,
  view: View,
}

type Contributions = NonNullable<ModManifestInput['contributes']>

const manifest = (viewers: Contributions['fileViewers']) =>
  modManifest.parse({
    id: 'probe',
    name: 'Probe',
    version: '1.0.0',
    seti: '^1.2',
    description: 'A mod the tests build',
    contributes: { fileViewers: viewers },
  } satisfies ModManifestInput)

const disposers: Disposer[] = []
const track = (dispose: Disposer) => {
  disposers.push(dispose)
  return dispose
}

afterEach(() => {
  disposeAll(disposers)
})

const pdf = { name: 'report.pdf', kind: 'pdf', size: 10 } as const

describe('file viewers', () => {
  it("show a file with the enabled mod's viewer of its kind, and with none once the mod stops", () => {
    expect(viewerFor(pdf, false, [PAGES])).toBeUndefined()
    claimFileViewers(manifest([{ id: 'pages', title: 'Pages', kinds: ['pdf'], text: false, phone: true }]), track)
    expect(viewerFor(pdf, false, [PAGES])?.key).toBe('probe.pages')
    expect(viewerFor(pdf, false, [])).toBeUndefined()
    disposeAll(disposers)
    expect(viewerFor(pdf, false, [PAGES])).toBeUndefined()
  })

  it('pass over a viewer for a file above its size, a phone it does not serve, or binary content', () => {
    claimFileViewers(
      manifest([
        { id: 'pages', title: 'Pages', kinds: ['pdf'], text: false, phone: true },
        { id: 'page', title: 'Page', extensions: ['xhtml'], text: true, page: true, phone: true },
      ]),
      track,
    )
    expect(viewerFor({ ...pdf, size: 11 }, false, [{ ...PAGES, maxBytes: 10 }])).toBeUndefined()
    expect(viewerFor(pdf, true, [{ ...PAGES, phone: false }])).toBeUndefined()
    const page = { ...PAGES, key: 'probe.page', kinds: [], extensions: ['xhtml'], text: true, page: true }
    expect(viewerFor({ name: 'a.xhtml', kind: 'text', size: 1 }, false, [page])?.key).toBe('probe.page')
    expect(viewerFor({ name: 'a.xhtml', kind: 'binary', size: 1 }, false, [page])).toBeUndefined()
  })

  it('read a new extension as its viewer says, and keep sniffing a page extension', () => {
    claimFileViewers(
      manifest([
        { id: 'notes', title: 'Notes', extensions: ['probenote'], text: true, phone: true },
        { id: 'page', title: 'Page', extensions: ['xhtml'], text: true, page: true, phone: true },
      ]),
      track,
    )
    expect(kindByName('a.probenote')).toBe('text')
    expect(kindByName('a.xhtml')).toBeNull()
    expect(isPageName('a.xhtml')).toBe(true)
    const notes = { ...PAGES, key: 'probe.notes', kinds: [], text: true }
    expect(viewerFor({ name: 'a.probenote', kind: 'text', size: 1 }, false, [notes])?.key).toBe('probe.notes')
    disposeAll(disposers)
    expect(kindByName('a.probenote')).toBeNull()
    expect(isPageName('a.xhtml')).toBe(false)
    expect(isPageName('a.html')).toBe(false)
  })

  it('refuse a second mod for a kind another mod shows, and a core extension', () => {
    const pages = manifest([{ id: 'pages', title: 'Pages', kinds: ['pdf'], text: false, phone: true }])
    claimFileViewers(pages, track)
    expect(() => {
      claimFileViewers({ ...pages, id: 'other' }, track)
    }).toThrow('The file kind viewer pdf is already registered')
    const md = manifest([{ id: 'md', title: 'Markdown', extensions: ['md'], text: true, phone: true }])
    expect(() => {
      claimFileViewers(md, track)
    }).toThrow(".md files are Seti's own")
  })

  it('name the bundled mod that is off and would show a file', () => {
    const probe = manifest([{ id: 'pages', title: 'Pages', kinds: ['pdf'], text: false, phone: true }])
    const info = { id: 'probe', tier: 'bundled', enabled: false, problem: null, manifest: probe } as ModInfo
    expect(modShowing([info], pdf)).toEqual({ mod: info, setting: null })
    expect(modShowing([{ ...info, enabled: true }], pdf)).toBeUndefined()
    expect(modShowing([{ ...info, tier: 'third-party' }], pdf)).toBeUndefined()
    expect(modShowing([info], { name: 'a.csv', kind: 'csv' })).toBeUndefined()
  })

  it('register a viewer once by its key', () => {
    const dispose = fileViewers.register(PAGES)
    expect(() => fileViewers.register(PAGES)).toThrow()
    dispose()
    expect(fileViewers.has('probe.pages')).toBe(false)
  })
})

describe('fence renderers', () => {
  it('find the renderer of a fence language, and none for other languages', () => {
    const mermaid: FenceRendererEntry = { language: 'mermaid', view: View }
    expect(rendererFor('mermaid', [mermaid])).toBe(mermaid)
    expect(rendererFor('python', [mermaid])).toBeUndefined()
    expect(rendererFor(null, [mermaid])).toBeUndefined()
    expect(rendererFor('mermaid', [])).toBeUndefined()
  })
})
