import { z } from 'zod'

/** The shelves Settings, Mods files a mod under; a manifest picks up to three. */
export const MOD_CATEGORIES = [
  'themes',
  'viewers',
  'channels',
  'integrations',
  'agents',
  'keyboard',
  'appearance',
  'other',
] as const
export type ModCategory = (typeof MOD_CATEGORIES)[number]

const LUCIDE_NAME = /^[a-z][a-z0-9-]{0,39}$/

/** An icon file in the package: an .svg or .png under plain folder names. */
const MOD_ICON_FILE = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:svg|png)$/

const MARKDOWN_FILE = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.md$/

/** Whether a manifest's icon names a file in the package rather than a lucide icon. */
export const isIconFile = (icon: string): boolean => MOD_ICON_FILE.test(icon)

const httpsUrl = z
  .string()
  .trim()
  .max(300)
  .refine((url) => {
    if (!URL.canParse(url)) {
      return false
    }
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
  }, 'Use an https:// URL with no user name or password')

const markdownFile = z.string().max(120).regex(MARKDOWN_FILE, 'Name a Markdown file in the package, such as README.md')

/** How a mod presents itself in Settings, Mods; Seti validates and shows these, never runs them. */
export const modListingFields = {
  /** The name Settings, Mods shows; `name` stays the short name consent and posts use. */
  displayName: z.string().trim().min(1).max(60).optional(),
  /** A lucide icon name, or an .svg or .png file in a third-party package. */
  icon: z
    .string()
    .max(120)
    .refine(
      (icon) => LUCIDE_NAME.test(icon) || isIconFile(icon),
      'Name a lucide icon, such as kanban, or an .svg or .png file in the package',
    )
    .optional(),
  categories: z
    .array(z.enum(MOD_CATEGORIES))
    .max(3)
    .default([])
    .refine((list) => new Set(list).size === list.length, 'A category is listed twice'),
  homepage: httpsUrl.optional(),
  repository: httpsUrl.optional(),
  /** Markdown shown on the mod's Details tab; README.md when absent. */
  readme: markdownFile.optional(),
  /** Markdown shown on the mod's Changelog tab; CHANGELOG.md when absent. */
  changelog: markdownFile.optional(),
}

/** The Markdown files a manifest points at, with the defaults Seti reads when it names none. */
export const modDocFiles = (manifest: { readme?: string | undefined; changelog?: string | undefined }) => ({
  readme: manifest.readme ?? 'README.md',
  changelog: manifest.changelog ?? 'CHANGELOG.md',
})

/** A mod's icon as the UI draws it: a lucide icon by name, or a checked image as a data URL. */
export type ModIcon = { kind: 'lucide'; name: string } | { kind: 'image'; url: string }

/** The name Settings, Mods shows for a mod. */
export const modTitle = (manifest: { name: string; displayName?: string | undefined }): string =>
  manifest.displayName ?? manifest.name

/** A mod's Markdown documents, read from its package; null where it has none. */
export interface ModDocs {
  readme: string | null
  changelog: string | null
}
