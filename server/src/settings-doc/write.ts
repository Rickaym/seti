import {
  SETTINGS_DOC_VERSION,
  SETTINGS_SECTIONS,
  applyPatch,
  diffPatch,
  isJsonObject,
  jsonWriteRefusal,
  keyedAt,
  patchPaths,
  valueAt,
  type DocPath,
  type SettingsConfirm,
  type SettingsDoc,
  type SettingsPatchResult,
  type SettingsProblem,
  type SettingsWriteRefusal,
} from '@seti/shared'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z } from 'zod'
import { currentRequestSource } from '../access.js'
import { transaction } from '../db.js'
import { HttpError } from '../http.js'
import type { ChangeSource } from '../revisions.js'
import { deferredWrite, type SettingsWrite } from '../settings-write.js'
import { revisions } from '../store/revisions.js'
import { settingsDoc, settingsDocZod } from './document.js'
import { SETTINGS_REVISION, revisionStates } from './write-revision.js'
import { SECTION_WRITERS, SectionProblem, writeMods } from './write-sections.js'

/** A refused JSON write: its status and what the client shows, never a value it sent. */
export class SettingsRefused extends HttpError {
  readonly refusal: SettingsWriteRefusal

  constructor(
    status: ContentfulStatusCode,
    refusal: Omit<SettingsWriteRefusal, 'confirm'> & { confirm?: SettingsConfirm[] },
  ) {
    super(status, refusal.detail)
    this.refusal = { ...refusal, confirm: refusal.confirm ?? [] }
  }
}

/** A JSON write as the route takes it, or as a revert makes it. */
export interface SettingsChange {
  base_revision: string
  patch: Record<string, unknown>
  expect: { path: DocPath; value?: unknown }[]
  confirm: string[]
}

/** Agents, mods and devices never write settings as JSON, whatever route calls this. */
function refuseDelegates(): void {
  const via = currentRequestSource()?.via
  if (via === 'agent' || via === 'mod' || via === 'device' || via === 'public') {
    throw new HttpError(403, 'Only you change settings as JSON')
  }
}

function refusedPaths(patch: Record<string, unknown>): SettingsProblem[] {
  return patchPaths(patch).flatMap((path) => {
    const refusal = jsonWriteRefusal(path)
    return refusal === null ? [] : [{ path, ...refusal }]
  })
}

function invalid(error: z.core.$ZodError): SettingsRefused {
  const problems = error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message }))
  return new SettingsRefused(400, {
    title: 'Invalid',
    detail: 'Some settings are not valid; nothing changed',
    problems,
  })
}

const startsWith = (path: DocPath, prefix: DocPath) => prefix.every((key, i) => path[i] === key)

/** Paths whose value is no longer what the client saw when it read the document. */
function stalePaths(doc: SettingsDoc, changed: DocPath[], change: SettingsChange): DocPath[] {
  if (change.base_revision === doc.revision) {
    return []
  }
  return changed.filter((path) => {
    const seen = change.expect.filter((entry) => startsWith(path, entry.path)).at(-1)
    const saw = seen === undefined ? undefined : valueAt(seen.value, path.slice(seen.path.length))
    return seen === undefined || JSON.stringify(saw) !== JSON.stringify(valueAt(doc, path))
  })
}

const DOC_KEYS = ['version', 'revision']

const DELETE_PATH = ['agents', 'lifecycle', 'auto_archive', 'delete_after_days'] as const

/** The ids of every change that needs the user's confirmation, which a revert gives. */
export const CONFIRM_IDS = [DELETE_PATH.join('.')]

/** Changes the settings pages show a consequence for, which the user must confirm. */
export function needsConfirm(doc: unknown, next: unknown, confirmed: readonly string[]): SettingsConfirm[] {
  const was = valueAt(doc, DELETE_PATH)
  const days = valueAt(next, DELETE_PATH)
  const id = DELETE_PATH.join('.')
  const deletes = typeof days === 'number' && (typeof was !== 'number' || days < was)
  if (!deletes || confirmed.includes(id)) {
    return []
  }
  const consequence = `Archived agents are deleted ${String(days)} days after archiving, with their transcripts and folders`
  return [{ id, consequence }]
}

async function applyChanged(doc: Record<string, unknown>, next: Record<string, unknown>, write: SettingsWrite) {
  for (const path of Object.keys(SETTINGS_SECTIONS)) {
    const writer = SECTION_WRITERS[path]
    const [group = '', page = ''] = path.split('.')
    const before = valueAt(doc, [group, page])
    const after = valueAt(next, [group, page])
    if (writer !== undefined && isJsonObject(before) && isJsonObject(after) && diffPatch(before, after) !== undefined) {
      await writer(after, before, write)
    }
  }
  const mods = (value: unknown) => (isJsonObject(value) ? value : {})
  await writeMods(mods(next.mods), mods(doc.mods), write)
}

/** Checks a change whole, then applies it in one transaction with one revision; else nothing. */
export async function writeSettings(change: SettingsChange, source: ChangeSource): Promise<SettingsPatchResult> {
  refuseDelegates()
  const { version } = change.patch
  const patch = Object.fromEntries(Object.entries(change.patch).filter(([key]) => !DOC_KEYS.includes(key)))
  if (version !== undefined && version !== SETTINGS_DOC_VERSION) {
    throw new HttpError(400, `Seti reads settings documents of version ${String(SETTINGS_DOC_VERSION)}`)
  }
  const refused = refusedPaths(patch)
  if (refused.length > 0) {
    const detail = 'Only plain settings change as JSON; nothing changed'
    throw new SettingsRefused(403, { title: 'Not writable', detail, problems: refused })
  }
  const doc = await settingsDoc()
  const schema = await settingsDocZod()
  const next = applyPatch(doc, patch, (path) => keyedAt(schema, path))
  const valid = schema.safeParse(next)
  if (!valid.success) {
    throw invalid(valid.error)
  }
  const changed = patchPaths(diffPatch(doc, next))
  if (changed.length === 0) {
    return { doc, revision: null, changed }
  }
  const stale = stalePaths(doc, changed, change)
  if (stale.length > 0) {
    const problems = stale.map((path) => ({ path, message: 'Changed since you read it' }))
    throw new SettingsRefused(409, {
      title: 'Changed since',
      detail: 'Some settings changed since you read them',
      problems,
    })
  }
  const confirm = needsConfirm(doc, next, change.confirm)
  if (confirm.length > 0) {
    throw new SettingsRefused(409, { title: 'Confirm', detail: 'Confirm what this change does', problems: [], confirm })
  }
  const after = next as Record<string, unknown>
  const { before, after: afterState } = revisionStates(doc, after, changed)
  const { revision, settle } = await transaction(async (tx) => {
    const deferred = deferredWrite(tx)
    await applyChanged(doc, after, deferred.write).catch((e: unknown) => {
      throw e instanceof SectionProblem
        ? new SettingsRefused(400, { title: 'Invalid', detail: e.message, problems: e.problems })
        : e
    })
    const reason = source.reason
    const row = { actor: source.actor, task_id: source.taskId, ...SETTINGS_REVISION, before, after: afterState, reason }
    return { revision: (await revisions.insert(row, tx)).id, settle: deferred.settle }
  })
  await settle()
  return { doc: await settingsDoc(), revision, changed }
}
