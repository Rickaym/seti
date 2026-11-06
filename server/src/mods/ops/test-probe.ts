import { modManifest, type ModManifest } from '@seti/shared'
import { asMod } from '../../access.js'
import { grantedFrom } from '../scopes.js'
import { callModOp, type ModOpResult } from './table.js'

/** A mod manifest for op tests, holding exactly these capabilities. */
export function probeManifest(
  capabilities: unknown[] = [],
  contributes: Record<string, unknown> = {},
  id = 'probe',
): ModManifest {
  return modManifest.parse({
    id,
    name: 'Probe',
    version: '1.0.0',
    seti: '^1.1',
    description: 'A probe mod for op tests',
    capabilities,
    contributes,
  })
}

interface ProbeCall {
  connectionId?: string | null
  eventId?: string
}

/** Calls one op as the runner does: as the mod, granted its manifest's capabilities, in one event. */
export async function callAs(
  manifest: ModManifest,
  op: string,
  args: unknown,
  { connectionId = null, eventId = 'event-1' }: ProbeCall = {},
): Promise<ModOpResult> {
  const rows = manifest.capabilities.map((capability) => ({
    capability,
    connection_id: capability.name === 'connection' ? connectionId : null,
  }))
  const { grants, scopes } = grantedFrom(rows)
  return asMod({ id: manifest.id, grants, scopes, eventId, caller: 'user' }, async () => callModOp(op, args, manifest))
}

/** The value a successful call returned; fails the test with the refusal otherwise. */
export function valueOf(result: ModOpResult): unknown {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`)
  }
  return result.value
}
