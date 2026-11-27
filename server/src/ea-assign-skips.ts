import type { EaAssignSkip, EaAssignSkipInput } from '@seti/shared'
import { audit } from './audit.js'
import { now, tasks } from './db.js'
import { refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { assignSkips, eaRelays } from './store/ea-relays.js'
import { teamMembers } from './store/team.js'

/** The task or channel id a skip names, from an id, a handle or a channel name. */
async function resolve({ kind, ref }: EaAssignSkipInput): Promise<string> {
  const bare = ref.replace(/^[@#]/, '')
  if (kind === 'channel') {
    const id = await eaRelays.channelRef(ref)
    if (id === undefined) {
      throw new HttpError(404, `No single channel has the id or name ${bare}`)
    }
    return id
  }
  const member = (await teamMembers.byHandles([bare])).at(0)
  const task = (await tasks.get(bare)) ?? (member === undefined ? undefined : await tasks.get(member.task_id))
  if (task === undefined) {
    throw new HttpError(404, `No agent has the id or handle ${bare}`)
  }
  return task.id
}

const named = async (kind: EaAssignSkip['kind'], ref: string): Promise<string> =>
  (await assignSkips.list()).find((skip) => skip.kind === kind && skip.ref === ref)?.name ?? ref

/** Stops the EA assigning to an agent or from a channel; the user or the EA on the user's word. */
export async function addAssignSkip(input: EaAssignSkipInput): Promise<EaAssignSkip[]> {
  refuseAgent('change where the EA assigns work')
  const ref = await resolve(input)
  if (await assignSkips.add(input.kind, ref, now())) {
    await audit.record({
      actor: 'user',
      kind: 'ea.assign_skip_added',
      subject_type: input.kind === 'agent' ? 'task' : 'ea',
      subject_id: ref,
      summary: `EA stops assigning ${input.kind === 'agent' ? 'to' : 'from'} "${await named(input.kind, ref)}"`,
      detail: { kind: input.kind, ref },
    })
  }
  return assignSkips.list()
}

/** Lets the EA assign to an agent or from a channel again, as the switch allows. */
export async function removeAssignSkip(input: EaAssignSkipInput): Promise<EaAssignSkip[]> {
  refuseAgent('change where the EA assigns work')
  const ref = await resolve(input)
  const name = await named(input.kind, ref)
  if (!(await assignSkips.remove(input.kind, ref))) {
    throw new HttpError(404, `The EA was not told to skip ${name}`)
  }
  await audit.record({
    actor: 'user',
    kind: 'ea.assign_skip_removed',
    subject_type: input.kind === 'agent' ? 'task' : 'ea',
    subject_id: ref,
    summary: `EA may assign ${input.kind === 'agent' ? 'to' : 'from'} "${name}" again`,
    detail: { kind: input.kind, ref },
  })
  return assignSkips.list()
}
