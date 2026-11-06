import { z } from 'zod'
import { isTextKind } from './files.js'
import { localName, title } from './mod-names.js'

/** Kinds Seti shows with viewers a bundled mod may take over; the kinds themselves stay Seti's. */
export const MOD_VIEWER_KINDS = ['mermaid', 'csv', 'spreadsheet', 'pdf'] as const

const extension = z
  .string()
  .max(16)
  .regex(/^[a-z0-9]+$/, 'An extension is lowercase letters and digits, without the dot')

/** The largest file a viewer may say it shows: Seti serves files to viewers up to this size. */
export const VIEWER_BYTES_MAX = 1024 * 1024 * 1024

export const fileViewer = z
  .strictObject({
    id: localName,
    title,
    extensions: z.array(extension).max(20).default([]),
    /** Seti's own kinds the viewer shows in place of Seti's viewer; bundled mods only. */
    kinds: z.array(z.enum(MOD_VIEWER_KINDS)).max(4).default([]),
    /** The viewer shows the file's text, so Seti reads it as text and the editor still opens it. */
    text: z.boolean(),
    /** Seti serves its extensions to the viewer's frame as sandboxed pages; bundled mods only. */
    page: z.boolean().default(false),
    /** Above this size Seti offers the download instead of the viewer. */
    maxBytes: z.number().int().min(1).max(VIEWER_BYTES_MAX).optional(),
    /** The viewer header offers a Source toggle that shows the file's text instead. */
    source: z.boolean().default(false),
    /** While the user edits the file, the viewer shows the saved version under the editor. */
    whileEditing: z.boolean().default(false),
    phone: z.boolean(),
    /** A third-party viewer's self-contained HTML page in the package. */
    entry: z.string().max(200).optional(),
    /** The boolean setting of the mod that turns this viewer on and off while the mod runs. */
    setting: localName.optional(),
  })
  .refine((entry) => entry.extensions.length + entry.kinds.length > 0, 'Name the extensions or kinds it shows')
  .refine((entry) => entry.kinds.every((kind) => isTextKind(kind) === entry.text), {
    message: 'A viewer of text kinds sets text, and one of other kinds does not',
  })
  .refine((entry) => !entry.page || (entry.text && entry.kinds.length === 0), {
    message: 'A page viewer shows text files by extension',
  })
  .refine((entry) => entry.text || !entry.whileEditing, 'Only a text viewer shows a file while it is edited')
  .refine((entry) => !entry.page || entry.setting === undefined, 'A page viewer runs while its mod runs')
export type ModFileViewer = z.output<typeof fileViewer>

/** A Markdown fence language whose blocks a mod draws, such as mermaid. */
export const fenceRenderer = z.strictObject({
  language: z
    .string()
    .max(30)
    .regex(/^[a-z][a-z0-9+#-]*$/, 'A fence language is lowercase, such as mermaid'),
  /** The boolean setting of the mod that turns this renderer on and off while the mod runs. */
  setting: localName.optional(),
})
