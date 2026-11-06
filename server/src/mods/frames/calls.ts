import { MOD_LIMITS, modCommandArgs, type ModFrameCallInput, type ModManifest } from '@seti/shared'
import type { ModViewCall } from './runtime.js'
import { describeIssues, HttpError } from '../../http.js'

/** Whether the manifest declares the view or viewer the call came from. */
const declaresPage = (manifest: ModManifest, name: string) =>
  manifest.contributes.views.some((view) => view.id === name) ||
  manifest.contributes.fileViewers.some((viewer) => viewer.id === name)

const KEYED = new Set(['storage.get', 'storage.set', 'storage.delete'])

/** A command the mod offers its own views, with its arguments as the manifest declares them. */
function checkCommand(manifest: ModManifest, input: ModFrameCallInput): Record<string, unknown> {
  const command = manifest.contributes.commands.find((entry) => entry.id === input.command)
  if (command === undefined) {
    throw new HttpError(404, `${manifest.name} has no command ${input.command ?? ''}`)
  }
  if (!command.for.includes('view')) {
    throw new HttpError(403, `${manifest.name} does not offer ${command.title} to its views`)
  }
  const parsed = modCommandArgs(command).safeParse(input.args ?? {})
  if (!parsed.success) {
    throw new HttpError(400, describeIssues(parsed.error))
  }
  return parsed.data
}

/**
 * The call as the mod's runtime takes it, or a refusal: the page must be declared, a command
 * must be offered to views, storage needs its key, and a value fits the store.
 */
export function checkViewCall(manifest: ModManifest, input: ModFrameCallInput): ModViewCall {
  if (!declaresPage(manifest, input.view)) {
    throw new HttpError(404, `${manifest.name} has no view ${input.view}`)
  }
  const call: ModViewCall = { ...input, modId: manifest.id }
  if (input.op === 'command') {
    return { ...call, args: checkCommand(manifest, input) }
  }
  if (KEYED.has(input.op) && input.key === undefined) {
    throw new HttpError(400, `${input.op} takes a key`)
  }
  if (input.op === 'storage.set') {
    const size = Buffer.byteLength(JSON.stringify(input.value ?? null))
    if (input.value === undefined || size > MOD_LIMITS.storageValueBytes) {
      throw new HttpError(400, 'A stored value is JSON of at most 64 KB')
    }
  }
  return call
}
