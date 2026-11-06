import { modScoped, type Disposer, type ModManifest } from '@seti/shared'
import { MOD_STYLES } from './bundled'

/** The CSS of each stylesheet the manifest declares, by `<mod>.<style>`; Seti ships every one. */
export async function stylesOf(
  manifest: ModManifest,
  shipped: Readonly<Record<string, () => Promise<string>>> = MOD_STYLES,
): Promise<{ id: string; css: string }[]> {
  return Promise.all(
    manifest.contributes.styles.map(async (declared) => {
      const id = modScoped(manifest.id, declared.id)
      const load = shipped[id]
      if (load === undefined) {
        throw new Error(`Seti ships no stylesheet ${id}`)
      }
      return { id, css: await load() }
    }),
  )
}

/** Adds the mod's stylesheets to the page while it runs; only bundled mods ship one. */
export async function registerStyles(manifest: ModManifest, track: (dispose: Disposer) => Disposer): Promise<void> {
  for (const { id, css } of await stylesOf(manifest)) {
    const style = document.createElement('style')
    style.dataset.modStyle = id
    style.textContent = css
    document.head.append(style)
    track(() => {
      style.remove()
    })
  }
}
