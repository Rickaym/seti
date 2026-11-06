import { Registry } from '@seti/shared'

/** One page of a mod's package: its HTML and the hashes of its inline scripts. */
interface ModFramePage {
  html: string
  /** CSP sources such as `sha256-<base64>`, computed when the package was installed. */
  scriptHashes: readonly string[]
}

/**
 * The pages of a running third-party mod. Install registers one per mod as it activates,
 * from the pinned `mod_version`, and its disposer removes it as the mod turns off.
 */
export interface ModFramePages {
  modId: string
  /** The full sha256 of the running package. */
  hash: string
  /** The page at a path the manifest names as an entry, or null when the package lacks it. */
  page: (entry: string) => ModFramePage | null
}

export const modFramePages = new Registry<ModFramePages>('mod frame pages', (pages) => pages.modId)
