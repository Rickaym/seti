import { MOD_LIMITS, MOD_OP_NAMES, type ModError, type ModErrorCode, type ModManifest, type ModOp } from '@seti/shared'
import { mayAuditRefusal } from '../../rate-limit.js'
import { redactSecrets } from '../../scrub.js'
import { modCall, requireOp } from '../capabilities.js'
import { basicOps } from './basics.js'
import { chatOps } from './chat.js'
import { connectionOps } from './connection.js'
import type { OpDefinition } from './define.js'
import { fileOps } from './files.js'
import { manageOps } from './manage.js'
import { netOps } from './net.js'
import { storageOps } from './storage.js'
import { taskReadOps } from './tasks.js'
import { audit } from '../../audit.js'
import { describeIssues, HttpError } from '../../http.js'
import type { OpTable } from '../logic/dispatch.js'

/** Every op a mod can call, one handler each; `MOD_OPS` names them and nothing else is reachable. */
const MOD_OP_TABLE: Readonly<Record<ModOp, OpDefinition>> = {
  ...basicOps,
  ...storageOps,
  ...netOps,
  ...connectionOps,
  ...taskReadOps,
  ...manageOps,
  ...chatOps,
  ...fileOps,
}

const isOp = (op: string): op is ModOp => Object.hasOwn(MOD_OP_TABLE, op)

/**
 * Runs one op for the mod `asMod` set, checking the grant, then the strict args, then the scopes
 * inside the handler. Throws HttpError on a refusal. The manifest is the version the mod runs.
 */
export async function runModOp(
  op: string,
  args: unknown,
  manifest: ModManifest,
  secret: (value: string) => void = () => undefined,
): Promise<unknown> {
  if (!isOp(op)) {
    throw new HttpError(400, `${op} is not an op a mod can call`)
  }
  const call = requireOp(op)
  if (manifest.id !== call.modId) {
    throw new HttpError(403, `The manifest of ${manifest.id} does not belong to the mod ${call.modId}`)
  }
  const definition = MOD_OP_TABLE[op]
  const parsed = definition.args.safeParse(args)
  if (!parsed.success) {
    throw new HttpError(400, `${op}: ${describeIssues(parsed.error)}`)
  }
  return definition.run(parsed.data, { call, manifest, secret })
}

/**
 * The op table the logic dispatcher runs: each call reads the manifest of the version the mod
 * runs, then runs the same op as bundled mods and views do.
 */
export function logicOps(manifestOf: (modId: string) => Promise<ModManifest | null>): OpTable {
  const handler =
    (op: ModOp) =>
    async (args: unknown, call: Parameters<OpTable[ModOp]>[1]): Promise<unknown> => {
      const manifest = await manifestOf(call.run.modId)
      if (manifest === null) {
        throw new HttpError(403, `${call.run.modId} is not installed and on`)
      }
      return runModOp(op, args, manifest, call.secret)
    }
  return Object.fromEntries(MOD_OP_NAMES.map((op) => [op, handler(op)])) as unknown as OpTable
}

/** The code the mod's Error carries, by the status the core gave. */
function codeOf(status: number): ModErrorCode {
  if (status === 403) {
    return 'denied'
  }
  if (status === 400 || status === 415 || status === 422) {
    return 'invalid'
  }
  return status === 413 || status === 429 ? 'limit' : 'failed'
}

/** A refusal reaches the audit log, capped per mod, so a mod that keeps trying cannot flood it. */
async function auditRefusal(modId: string, op: string, reason: string): Promise<void> {
  if (!mayAuditRefusal(`mod:${modId}`)) {
    return
  }
  await audit.record({
    actor: 'user',
    kind: 'mod.call_refused',
    subject_type: 'mod',
    subject_id: modId,
    summary: `Refused ${op} of the mod ${modId}: ${reason}`,
    detail: { op, reason },
  })
}

export type ModOpResult = { ok: true; value: unknown } | { ok: false; error: ModError }

/**
 * Runs one op and answers as the runner pipe and the view bridge do: the value, or an error with
 * its code. Refusals are audited; no error text carries a secret.
 */
export async function callModOp(op: string, args: unknown, manifest: ModManifest): Promise<ModOpResult> {
  const { modId } = modCall()
  try {
    const value = (await runModOp(op, args, manifest)) ?? null
    if (Buffer.byteLength(JSON.stringify(value)) > MOD_LIMITS.callResultBytes) {
      throw new HttpError(413, `The result of ${op} is over ${String(MOD_LIMITS.callResultBytes / 1024 / 1024)} MB`)
    }
    return { ok: true, value }
  } catch (e) {
    const known = e instanceof HttpError
    const message = redactSecrets(known ? e.message : `${op} failed`).slice(0, 2000)
    const code = known ? codeOf(e.status) : 'failed'
    if (code === 'denied') {
      await auditRefusal(modId, op, message)
    }
    return { ok: false, error: { code, message } }
  }
}
