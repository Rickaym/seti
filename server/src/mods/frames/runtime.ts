import { randomUUID } from 'node:crypto'
import type { ModError, ModFrameCallInput, ModManifest } from '@seti/shared'
import { asMod } from '../../access.js'
import { installedMods } from '../../store/mod-installed.js'
import { runCommandEvent } from '../logic/service.js'
import { callModOp } from '../ops/table.js'
import { grantedFrom } from '../scopes.js'

/** A call a mod's view made through the bridge, after Seti checked the mod, view and command. */
export type ModViewCall = Omit<ModFrameCallInput, 'view'> & { modId: string; view: string }

type ModViewAnswer = { ok: true; value: unknown } | { ok: false; error: ModError }

/** The op's args as the op table takes them; the mod's id never comes from the view. */
function opArgs(call: ModViewCall): Record<string, unknown> {
  switch (call.op) {
    case 'storage.get':
    case 'storage.delete':
      return { key: call.key }
    case 'storage.keys':
      return call.prefix === undefined ? {} : { prefix: call.prefix }
    case 'storage.set':
      return { key: call.key, value: call.value }
    case 'settings.get':
    case 'command':
      return {}
  }
}

/**
 * Runs a view's call as the mod, with `caller: 'view'`: a command as an onCommand event in the
 * logic pool, and storage and settings through the op table under the mod's own grants. The
 * user's session only carried the call here.
 */
export async function runViewCall(call: ModViewCall, manifest: ModManifest): Promise<ModViewAnswer> {
  if (call.op === 'command') {
    const result = await runCommandEvent(call.modId, call.command ?? '', call.args ?? {}, { caller: 'view' })
    return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error }
  }
  const { grants, scopes } = grantedFrom(await installedMods.grants(call.modId))
  const run = { id: call.modId, grants, scopes, eventId: randomUUID(), caller: 'view' as const }
  return asMod(run, async () => callModOp(call.op, opArgs(call), manifest))
}
