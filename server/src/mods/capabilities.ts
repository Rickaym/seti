import { MOD_OPS, type ModCapabilityName, type ModOp } from '@seti/shared'
import { currentRequestSource } from '../access.js'
import { HttpError } from '../http.js'

/** Calls only bundled mods' server code makes, beside the op table every mod shares. */
const BUNDLED_OPS = {
  'seti.version': 'seti.version',
  'workspaces.layout': 'workspaces.layout',
  'tasks.ask': 'tasks.ask',
} as const satisfies Record<string, ModCapabilityName>

/** Every call a mod can make into Seti; the op table in `MOD_OPS` is the whole third-party set. */
export type ServerOp = ModOp | keyof typeof BUNDLED_OPS

/** The one place that says which capability each call needs; null for what every mod may do. */
const CAPABILITY_OF: Readonly<Record<ServerOp, ModCapabilityName | null>> = { ...MOD_OPS, ...BUNDLED_OPS }

/** The request source of a call a mod makes, with its grants and their scopes. */
export type ModCall = Extract<NonNullable<ReturnType<typeof currentRequestSource>>, { via: 'mod' }>

/** The mod making the current call; refuses a call made outside the mod source. */
export function modCall(): ModCall {
  const source = currentRequestSource()
  if (source?.via !== 'mod') {
    throw new HttpError(403, 'The mod API answers only a mod')
  }
  return source
}

/** The mod making the current call, once the op is within its grants. */
export function requireOp(op: ServerOp): ModCall {
  const call = modCall()
  const capability = CAPABILITY_OF[op]
  if (capability !== null && !call.grants.includes(capability)) {
    throw new HttpError(403, `The mod ${call.modId} was not granted ${capability}`)
  }
  return call
}
