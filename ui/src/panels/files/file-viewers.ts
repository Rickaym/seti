import type { ModFileViewProps, ModLazyView } from '@seti/mod-api'
import {
  extensionOf,
  isTextKind,
  modViewerKey,
  Registry,
  type FileKind,
  type ModFileViewer,
  type ModInfo,
} from '@seti/shared'
import { lazy, useSyncExternalStore, type ComponentType } from 'react'
import { useNarrow } from '@/hooks/useMedia'

/** A viewer of files an enabled mod adds. */
export interface FileViewerEntry {
  /** `<mod>.<viewer>`. */
  key: string
  title: string
  kinds: readonly FileKind[]
  extensions: readonly string[]
  /** Shows the file's text, which Seti reads for it, in the text view. */
  text: boolean
  /** Gets the file as a sandboxed page for a frame. */
  page: boolean
  /** Above this size the file opens as text or offers its download instead. */
  maxBytes: number | null
  /** Offers the Source toggle. */
  source: boolean
  /** Shows the saved file under the editor while the user edits it. */
  whileEditing: boolean
  phone: boolean
  view: ComponentType<ModFileViewProps>
}

export const fileViewers = new Registry<FileViewerEntry>('file viewer', (viewer) => viewer.key)

/** What picks a file's viewer. */
export interface ViewedFile {
  name: string
  kind: FileKind
  size: number
}

const fits = (viewer: FileViewerEntry, file: ViewedFile, narrow: boolean) =>
  (viewer.maxBytes === null || file.size <= viewer.maxBytes) &&
  (viewer.phone || !narrow) &&
  (!viewer.text || isTextKind(file.kind))

/**
 * The enabled mod's viewer of the file's extension, else of its kind, when the file fits it; with
 * none, the file opens as text or offers its download.
 */
export function viewerFor(
  file: ViewedFile,
  narrow: boolean,
  viewers: readonly FileViewerEntry[] = fileViewers.list(),
): FileViewerEntry | undefined {
  const key = modViewerKey(file.name, file.kind)
  const viewer = viewers.find((entry) => entry.key === key)
  return viewer !== undefined && fits(viewer, file, narrow) ? viewer : undefined
}

/** The viewer of the file, following mods as they turn on and off; undefined for none. */
export function useFileViewer(file: ViewedFile | null): FileViewerEntry | undefined {
  const viewers = useSyncExternalStore(fileViewers.subscribe, fileViewers.list)
  const narrow = useNarrow()
  return file === null ? undefined : viewerFor(file, narrow, viewers)
}

/** A bundled mod that would show the file but is off, or whose switch for the file is off. */
interface OffShowing {
  mod: ModInfo
  /** The mod's switch that is off, or null when the whole mod is off. */
  setting: string | null
}

/** What would show the file if the user turned it on, if anything. */
export function modShowing(mods: readonly ModInfo[], file: Pick<ViewedFile, 'name' | 'kind'>): OffShowing | undefined {
  const extension = extensionOf(file.name)
  const shows = (viewer: ModFileViewer) =>
    viewer.extensions.includes(extension) || (viewer.kinds as readonly FileKind[]).includes(file.kind)
  for (const mod of mods) {
    const viewer = mod.manifest?.contributes.fileViewers.find(shows)
    if (mod.tier !== 'bundled' || mod.problem !== null || viewer === undefined) {
      continue
    }
    if (!mod.enabled) {
      return { mod, setting: null }
    }
    if (viewer.setting !== undefined && mod.off_switches.includes(viewer.setting)) {
      return { mod, setting: viewer.setting }
    }
  }
  return undefined
}

/** A view given as its component, or loaded as its own chunk the first time it shows. */
export const lazyView = <P extends object>(given: ModLazyView<P>): ComponentType<P> =>
  'view' in given ? given.view : lazy(async () => ({ default: await given.load() }))
