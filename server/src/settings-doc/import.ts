import {
  applyPatch,
  IMPORT_DEPTH_MAX,
  isJsonObject,
  jsonWriteRefusal,
  keyedAt,
  patchOf,
  patchPaths,
  pathText,
  SETTINGS_DOC_VERSION,
  valueAt,
  type DocPath,
  type ImportChange,
  type SettingsImportInput,
  type SettingsImportPreview,
  type SettingsPatchResult,
  type SettingsProblem,
} from '@seti/shared'
import { HttpError } from '../http.js'
import { byUser } from '../revisions.js'
import { settingsDoc, settingsDocZod } from './document.js'
import { changedParts, pointerOf } from './write-revision.js'
import { needsConfirm, SettingsRefused, writeSettings } from './write.js'

type Patch = Record<string, unknown>

function depthOf(value: unknown): number {
  if (Array.isArray(value)) {
    return 1 + Math.max(0, ...value.map(depthOf))
  }
  return isJsonObject(value) ? 1 + Math.max(0, ...Object.values(value).map(depthOf)) : 0
}

/** Settings that decide what agents may run or reach: offered one by one, never applied in bulk. */
const isOffered = (path: DocPath) =>
  (path[0] === 'capabilities' && path[1] === 'mcp_servers') || (path[0] === 'mods' && path[2] === 'settings')

const merged = (paths: DocPath[], file: unknown): Patch =>
  paths.reduce<Patch>((patch, path) => applyPatch(patch, patchOf(path, valueAt(file, path)), () => false) as Patch, {})

const NOT_HERE = { message: 'This mod is not installed here', page: 'mods' }

/** Why an import leaves a path alone, or null when it may change it. */
function importRefusal(path: DocPath, doc: unknown): Omit<SettingsProblem, 'path'> | null {
  const mods = valueAt(doc, ['mods'])
  if (path[0] === 'mods' && !(isJsonObject(mods) && (path[1] ?? '') in mods)) {
    return NOT_HERE
  }
  return jsonWriteRefusal(path)
}

/** What the file holds that an import never changes, once per setting rather than per leaf. */
function skippedOf(paths: DocPath[], doc: unknown): SettingsProblem[] {
  const seen = new Map<string, SettingsProblem>()
  for (const path of paths) {
    const refusal = importRefusal(path, doc)
    const head = path.slice(0, 3)
    if (refusal !== null && !seen.has(pathText(head))) {
      seen.set(pathText(head), { path: head, ...refusal })
    }
  }
  return [...seen.values()]
}

interface Plan {
  preview: SettingsImportPreview
  plain: Patch
  offered: Map<string, DocPath>
  revision: string
}

async function plan(input: SettingsImportInput): Promise<Plan> {
  const file = input.file
  if (depthOf(file) > IMPORT_DEPTH_MAX) {
    throw new HttpError(400, 'The file nests deeper than a settings export does')
  }
  if (file.version !== undefined && file.version !== SETTINGS_DOC_VERSION) {
    throw new HttpError(400, `Seti imports settings files of version ${String(SETTINGS_DOC_VERSION)}`)
  }
  const body = Object.fromEntries(Object.entries(file).filter(([key]) => key !== 'version' && key !== 'revision'))
  const doc = await settingsDoc()
  const paths = patchPaths(body)
  const allowed = paths.filter((path) => importRefusal(path, doc) === null)
  const differs = (path: DocPath) => JSON.stringify(valueAt(doc, path)) !== JSON.stringify(valueAt(body, path))
  const offeredPaths = allowed.filter((path) => isOffered(path) && differs(path))
  const plain = merged(
    allowed.filter((path) => !isOffered(path)),
    body,
  )
  const schema = await settingsDocZod()
  const keyed = (path: DocPath) => keyedAt(schema, path)
  const nextPlain = applyPatch(doc, plain, keyed)
  const nextAll = applyPatch(nextPlain, merged(offeredPaths, body), keyed)
  const valid = schema.safeParse(nextAll)
  const problems = valid.success
    ? []
    : valid.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message }))
  const change = (path: DocPath): ImportChange => ({
    id: pointerOf(path),
    path,
    before: valueAt(doc, path),
    after: valueAt(body, path),
  })
  const changes = changedParts(doc, nextPlain).map((path) => ({ ...change(path), after: valueAt(nextPlain, path) }))
  const preview = {
    changes,
    offered: offeredPaths.map(change),
    skipped: skippedOf(paths, doc),
    problems,
    confirm: needsConfirm(doc, nextAll, []),
  }
  return {
    preview,
    plain,
    offered: new Map(offeredPaths.map((path) => [pointerOf(path), path])),
    revision: doc.revision,
  }
}

/** What an import would change, offer and skip; nothing applies. */
export async function previewImport(input: SettingsImportInput): Promise<SettingsImportPreview> {
  return (await plan(input)).preview
}

/** Applies an import's plain settings and the offered items the user ticked, as one revision. */
export async function applyImport(input: SettingsImportInput): Promise<SettingsPatchResult> {
  const { preview, plain, offered, revision } = await plan(input)
  if (preview.problems.length > 0) {
    const detail = 'Some settings in the file are not valid; nothing changed'
    throw new SettingsRefused(400, { title: 'Invalid', detail, problems: preview.problems })
  }
  const accepted = (input.accept ?? []).flatMap((id) => {
    const path = offered.get(id)
    return path === undefined ? [] : [path]
  })
  const patch = accepted.reduce<Patch>(
    (all, path) => applyPatch(all, patchOf(path, valueAt(input.file, path)), () => false) as Patch,
    plain,
  )
  const change = { base_revision: revision, patch, expect: [], confirm: input.confirm ?? [] }
  return writeSettings(change, byUser('Imported settings from a file'))
}
