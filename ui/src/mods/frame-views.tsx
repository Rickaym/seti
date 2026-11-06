import type { ModFileViewProps, ModSectionProps } from '@seti/mod-api'
import { modScoped, secretNameProblem, type Disposer, type ModManifest } from '@seti/shared'
import { Package } from 'lucide-react'
import type { ComponentType } from 'react'
import { commandRegistry } from '@/components/palette/registry'
import { sectionRegistry } from '@/lib/sections'
import { fileViewers } from '@/panels/files/file-viewers'
import { ModFrame } from './ModFrame'
import { agentTabs, showFrame, sidePanels, type PlacedFrame } from './frame-places'

type View = ModManifest['contributes']['views'][number]
type Viewer = ModManifest['contributes']['fileViewers'][number]

function sectionView(manifest: ModManifest, view: View): ComponentType<ModSectionProps> {
  function ModSection() {
    const { id, name } = manifest
    return (
      <ModFrame
        modId={id}
        modName={name}
        kind="views"
        name={view.id}
        title={view.title}
        place="section"
        phone={view.phone}
      />
    )
  }
  return ModSection
}

/** The file's path in its folder, from its raw URL, so a file in a secret folder counts too. */
const filePath = (file: ModFileViewProps) =>
  new URL(file.url, window.location.href).searchParams.get('path') ?? file.name

function fileView(manifest: ModManifest, viewer: Viewer): ComponentType<ModFileViewProps> {
  function ModFileView(file: ModFileViewProps) {
    const { id, name } = manifest
    if (secretNameProblem(filePath(file)) !== null) {
      return (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          Seti keeps {file.name} from the {name} mod: it looks like a key, credential or env file.
        </p>
      )
    }
    return (
      <ModFrame
        modId={id}
        modName={name}
        kind="viewers"
        name={viewer.id}
        title={viewer.title}
        place="fileViewer"
        phone={viewer.phone}
        file={file}
      />
    )
  }
  return ModFileView
}

const placed = (manifest: ModManifest, view: View): PlacedFrame => ({
  key: modScoped(manifest.id, view.id),
  modId: manifest.id,
  modName: manifest.name,
  view: view.id,
  title: view.title,
  phone: view.phone,
})

function registerView(manifest: ModManifest, view: View, track: (dispose: Disposer) => Disposer): void {
  const key = modScoped(manifest.id, view.id)
  switch (view.where) {
    case 'section':
      track(
        sectionRegistry.register({
          key,
          label: view.title,
          icon: Package,
          group: 'Mods',
          digit: null,
          view: sectionView(manifest, view),
        }),
      )
      return
    case 'agentTab':
      track(agentTabs.register(placed(manifest, view)))
      return
    case 'sidePanel':
      track(sidePanels.register(placed(manifest, view)))
      track(
        commandRegistry.register([
          {
            id: `mod.${key}.open`,
            title: `Open ${view.title}`,
            detail: `${manifest.name} mod`,
            icon: Package,
            group: 'View',
            run: () => {
              showFrame({ key, agentId: null })
            },
          },
        ]),
      )
      return
    case 'agentDock':
    case 'agentsLayout':
    case 'header':
    case 'about':
      throw new Error(`A third-party view cannot sit in ${view.where}`)
  }
}

/**
 * Places a third-party mod's views and file viewers as sandboxed frames: Seti draws the chrome
 * and the frame, and the mod's page reaches Seti only through the bridge.
 */
export function registerFrameViews(manifest: ModManifest, track: (dispose: Disposer) => Disposer): void {
  for (const view of manifest.contributes.views) {
    registerView(manifest, view, track)
  }
  for (const viewer of manifest.contributes.fileViewers) {
    const { id, maxBytes, ...declared } = viewer
    const key = modScoped(manifest.id, id)
    const view = fileView(manifest, viewer)
    track(fileViewers.register({ ...declared, key, maxBytes: maxBytes ?? null, view }))
  }
}
