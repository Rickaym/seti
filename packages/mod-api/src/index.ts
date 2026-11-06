import type { ServerModApi } from './server.js'
import type { UiModApi } from './ui.js'

export type {
  AuditDetail,
  Changelog,
  ChangelogEntry,
  ChangelogStatus,
  Disposer,
  FileKind,
  ModCapability,
  ModManifest,
  ModManifestInput,
  ModSettingField,
  Preview,
  PreviewStatus,
  PullRequest,
  SetiUpdate,
  SetiVersion,
  TerminalRef,
  GridLayout,
  WorkspaceGrid,
  SideChatEvent,
  TaskDisplayStatus,
  AgentColor,
  SubtaskBrief,
  TaskListEntry,
} from '@seti/shared'
export {
  firstText,
  GRID_COLS,
  listedStatus,
  TERMINAL_NAME_MAX,
  isRecord,
  orNull,
  previewStatus,
  recordAt,
  SETI_HOST,
  SETI_HOSTNAMES,
  SIDE_CHAT_TURNS,
  SIDE_QUESTION_MAX,
  sideChatEvent,
  textAt,
  timeOf,
  type JsonRecord,
} from '@seti/shared'
export type * from './agents.js'
export type * from './server.js'
export type * from './ui.js'

/**
 * A bundled mod: its manifest, and the halves that run in Seti's server and in its UI. The
 * manifest is the parsed `seti-mod.json`, which Seti validates before any half runs.
 */
export interface ModDefinition {
  manifest: unknown
  server?: (api: ServerModApi) => void | Promise<void>
  ui?: (api: UiModApi) => void | Promise<void>
}

/** Declares a mod; its server and UI halves live in separate files so neither loads the other. */
export const defineMod = <T extends ModDefinition>(definition: T): T => definition
