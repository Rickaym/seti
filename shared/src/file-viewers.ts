import { extensionKinds, extensionOf, isCoreExtension, type FileKind } from './files.js'
import type { ModContributions } from './mod-contributions.js'
import { modScoped, type ModManifest } from './mods.js'
import { Registry, type Disposer } from './registry.js'

/** A kind of Seti's that an enabled bundled mod's viewer shows. */
export interface KindViewer {
  kind: FileKind
  /** The viewer, as `<mod>.<viewer>`. */
  viewer: string
}

export const kindViewers = new Registry<KindViewer>('file kind viewer', (entry) => entry.kind)

/** An extension an enabled mod's viewer frames as a sandboxed page. */
export interface PageExtension {
  extension: string
  viewer: string
}

export const pageExtensions = new Registry<PageExtension>('page extension', (entry) => entry.extension)

/** A Markdown fence language an enabled mod draws. */
export const fenceLanguages = new Registry<{ language: string; mod: string }>(
  'fence renderer',
  (entry) => entry.language,
)

type Track = (dispose: Disposer) => Disposer

function claimViewer(mod: string, entry: ModManifest['contributes']['fileViewers'][number], track: Track): void {
  const viewer = modScoped(mod, entry.id)
  for (const extension of entry.extensions) {
    if (isCoreExtension(extension)) {
      throw new Error(`.${extension} files are Seti's own; a mod shows them through their kind`)
    }
    track(
      entry.page
        ? pageExtensions.register({ extension, viewer })
        : extensionKinds.register({ extension, kind: entry.text ? 'text' : 'binary', viewer }),
    )
  }
  for (const kind of entry.kinds) {
    track(kindViewers.register({ kind, viewer }))
  }
}

/**
 * Registers the files a mod's viewers show, as the server and the UI both do from its manifest:
 * an extension Seti does not know, a kind of Seti's, or an extension served as a page. Page
 * extensions stay out of `extensionKinds`, so Seti still tells text from binary by the content.
 */
export function claimFileViewers(manifest: ModManifest, track: Track): void {
  for (const entry of manifest.contributes.fileViewers) {
    claimViewer(manifest.id, entry, track)
  }
  for (const { language } of manifest.contributes.fenceRenderers) {
    track(fenceLanguages.register({ language, mod: manifest.id }))
  }
}

/** The enabled mod viewer that shows the file, as `<mod>.<viewer>`; by extension, then by kind. */
export function modViewerKey(name: string, kind: FileKind): string | undefined {
  const extension = extensionOf(name)
  return extensionKinds.get(extension)?.viewer ?? pageExtensions.get(extension)?.viewer ?? kindViewers.get(kind)?.viewer
}

/** Whether a viewer serves files of this name as sandboxed pages. */
export const isPageName = (name: string): boolean => pageExtensions.has(extensionOf(name))

/** The boolean settings that turn a mod's file viewers or fence renderers on and off. */
export const modSwitches = (contributes: ModContributions): string[] => [
  ...new Set(
    [...contributes.fileViewers, ...contributes.fenceRenderers].flatMap((entry) =>
      entry.setting === undefined ? [] : [entry.setting],
    ),
  ),
]
