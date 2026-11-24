import { z } from 'zod'
import type { DocPath } from './settings-doc-modified.js'
import type { SettingsConfirm, SettingsProblem } from './settings-doc-write.js'

/** An imported file as the client sends it; the server checks everything in it. */
export const settingsImportInput = z.strictObject({
  /** The file's JSON, a whole export or a part of one. */
  file: z.record(z.string(), z.unknown()),
  /** The items offered one by one that the user ticked, by id. */
  accept: z.array(z.string().max(2000)).max(500).default([]),
  /** The consequences the user confirmed, by id. */
  confirm: z.array(z.string().max(300)).max(50).default([]),
})
export type SettingsImportInput = z.input<typeof settingsImportInput>

/** One setting an import would change. */
export interface ImportChange {
  /** A JSON Pointer of the path, which `accept` names for an offered item. */
  id: string
  path: DocPath
  before: unknown
  after: unknown
}

/** What an import would do, shown before anything applies. */
export interface SettingsImportPreview {
  /** Plain settings that apply with the import. */
  changes: ImportChange[]
  /** Settings that decide what agents may run or reach, each applied only when ticked. */
  offered: ImportChange[]
  /** What the file holds that an import never changes, with the page where it changes. */
  skipped: SettingsProblem[]
  /** Values in the file that are not valid; nothing applies until the file is fixed. */
  problems: SettingsProblem[]
  /** Consequences to confirm before the import applies. */
  confirm: SettingsConfirm[]
}

/** The deepest an imported file may nest; the document itself is about six deep. */
export const IMPORT_DEPTH_MAX = 12
