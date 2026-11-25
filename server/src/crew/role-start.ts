import { RUNTIME_NAMES, type ContextPack, type StartAgentRequest, type StoredRuntime } from '@seti/shared'
import { requireRuntime } from '../codex-status.js'
import { HttpError } from '../http.js'
import { pickedRuntime } from '../runtime-offers.js'
import { contextPacks } from '../store/context.js'

/** What a start's role decides: its pack, the runtime and model, and why a pick fell back. */
export interface RoleStart {
  role: ContextPack | null
  runtime: StoredRuntime | undefined
  model: string | undefined
  held: string[]
}

const ownPicks = (input: StartAgentRequest, role: ContextPack | null, held: string[] = []): RoleStart => ({
  role,
  runtime: input.runtime,
  model: input.model,
  held,
})

/** The role's runtime when it can start an agent for this credential now; the reason otherwise. */
async function roleRuntime(
  role: ContextPack,
  profileId: string,
): Promise<{ runtime: StoredRuntime } | { why: string }> {
  try {
    const runtime = pickedRuntime({ runtime: role.runtime ?? undefined, model: role.model ?? undefined })
    await requireRuntime(runtime, profileId)
    return { runtime }
  } catch (error) {
    if (error instanceof HttpError) {
      return { why: error.message }
    }
    throw error
  }
}

/**
 * The role a start names, and the runtime and model it runs on: the start's own picks first, then
 * the role's, then the install's default when the role's runtime cannot start an agent now.
 */
export async function roleStart(input: StartAgentRequest, profileId: string): Promise<RoleStart> {
  if (input.role === undefined) {
    return ownPicks(input, null)
  }
  const role = await contextPacks.roleNamed(input.role)
  if (role === undefined) {
    throw new HttpError(404, `No role is named ${input.role}`)
  }
  if (input.runtime !== undefined || input.model !== undefined || (role.runtime === null && role.model === null)) {
    return ownPicks(input, role)
  }
  const picked = await roleRuntime(role, profileId)
  if ('why' in picked) {
    const named = role.runtime === null ? (role.model ?? '') : RUNTIME_NAMES[role.runtime]
    return ownPicks(input, role, [`${named} for the ${role.name} role: ${picked.why}`])
  }
  return { role, runtime: picked.runtime, model: role.model ?? undefined, held: [] }
}

/** The planner's packs with the start's role in place of any role it picked. */
export async function withRole(packIds: readonly string[], role: ContextPack | null): Promise<string[]> {
  if (role === null) {
    return [...packIds]
  }
  const roles = new Set((await contextPacks.list()).filter((pack) => pack.kind === 'role').map((pack) => pack.id))
  return [...packIds.filter((id) => !roles.has(id)), role.id]
}
