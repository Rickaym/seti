import { randomUUID } from 'node:crypto'
import {
  createTaskInput,
  DEFAULT_PROFILE_ID,
  MOD_LIMITS,
  type ModAsk,
  type ModAskDecision,
  type ModAskOp,
  type ModAskState,
} from '@seti/shared'
import { asMod, currentRequestSource } from '../access.js'
import { audit } from '../audit.js'
import { SAFE_MODE_FORCED } from '../config.js'
import { now, repos } from '../db.js'
import { fromDelegate } from '../ea-guard.js'
import { HttpError } from '../http.js'
import { pushToEveryDevice } from '../notifications.js'
import { modAsks } from '../store/mod-asks.js'
import { installedMods } from '../store/mod-installed.js'
import { modHostSettings } from '../store/mods.js'
import { stopTask } from '../task-transcript.js'
import { startTask } from '../tasks.js'
import type { ModCall } from './capabilities.js'
import { runningMods } from './running.js'
import { grantedFrom, visibleTask } from './scopes.js'

const PROMPT_SHOWN = 600

const STANDING: Record<ModAskState, string> = {
  pending: 'still open',
  expired: 'expired; the mod can ask again',
  allowed: 'already allowed',
  denied: 'already denied',
  done: 'already allowed and done',
  failed: 'already allowed, and it failed',
}

/** What the ask says, written by Seti from the op and its args, never from the mod's own text. */
function summaryOf(name: string, op: ModAskOp, args: Record<string, unknown>, target: string): string {
  if (op === 'tasks.manage.start') {
    const prompt = String(args.prompt)
    const shown = prompt.length > PROMPT_SHOWN ? `${prompt.slice(0, PROMPT_SHOWN)}...` : prompt
    const where = typeof args.repo_slug === 'string' ? ` in ${args.repo_slug}` : ''
    return `The ${name} mod wants to start an agent "${String(args.title)}"${where} with this prompt: ${shown}`
  }
  return `The ${name} mod wants to stop the running turn of "${target}"`
}

/** The args with the slug of the repo they name, so the user sees where an agent would start. */
async function withRepo(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof args.repo !== 'string') {
    return args
  }
  const repo = await repos.get(args.repo)
  if (repo === undefined) {
    throw new HttpError(404, `Seti has no repo ${args.repo}`)
  }
  return { ...args, repo_slug: repo.slug }
}

/**
 * Records what the mod asks for and tells the user; nothing runs until the user allows it. A mod
 * keeps at most a few asks open, so it cannot bury the user in them.
 */
export async function askUser(
  call: ModCall,
  { name, op, args, target = '' }: { name: string; op: ModAskOp; args: Record<string, unknown>; target?: string },
): Promise<{ asked: string }> {
  const at = now()
  const recorded = await withRepo(args)
  if ((await modAsks.openCount(call.modId, at)) >= MOD_LIMITS.openAsks) {
    throw new HttpError(429, `The ${call.modId} mod has ${String(MOD_LIMITS.openAsks)} asks open already`)
  }
  const ask = await modAsks.add({
    id: randomUUID(),
    mod_id: call.modId,
    op,
    args: recorded,
    summary: summaryOf(name, op, recorded, target),
    created_at: at,
    expires_at: new Date(Date.parse(at) + MOD_LIMITS.askTtlMs).toISOString(),
  })
  await pushToEveryDevice({
    title: 'A mod asks you',
    body: ask.summary.slice(0, MOD_LIMITS.notifyBodyChars),
    tag: `mod_ask:${ask.id}`,
    kind: 'mod_ask',
    url: '/#settings/mods',
  }).catch(() => 0)
  return { asked: ask.id }
}

/** Only the user's session or local token answers an ask; never a delegate or a device. */
function refuseNotUser(): void {
  if (fromDelegate() || currentRequestSource()?.via === 'device') {
    throw new HttpError(403, "Only the user answers a mod's ask, in Seti")
  }
}

/** Runs the exact call the mod asked for, as the mod, within the grants it holds now. */
async function runAllowed(ask: ModAsk): Promise<string> {
  const off = !runningMods.has(ask.mod_id) || SAFE_MODE_FORCED || (await modHostSettings.safeMode())
  const { grants, scopes } = grantedFrom(off ? [] : await installedMods.grants(ask.mod_id))
  if (!grants.includes('tasks.manage')) {
    throw new HttpError(409, `The ${ask.mod_id} mod is off or no longer holds tasks.manage`)
  }
  return asMod({ id: ask.mod_id, grants, scopes, caller: 'user-allowed' }, async () => {
    if (ask.op === 'tasks.manage.stop') {
      const task = await visibleTask(scopes['tasks.read']?.agents, String(ask.args.id))
      await stopTask(task.id)
      return `Stopped the turn of "${task.title}"`
    }
    const input = createTaskInput.parse({
      title: ask.args.title,
      prompt: ask.args.prompt,
      repo_ids: typeof ask.args.repo === 'string' ? [ask.args.repo] : [],
      sandbox: true,
      profile_id: DEFAULT_PROFILE_ID,
      seti_control: 'self',
    })
    const task = await startTask({ ...input, title: String(ask.args.title) })
    return `Started "${task.title}" (${task.id})`
  })
}

/**
 * The user's Allow or Deny for one ask a mod made. Each open ask takes one answer. Allow runs
 * the recorded call; an agent it starts is sandboxed at Self on the default credential.
 */
export async function decideModAsk(id: string, decision: ModAskDecision): Promise<ModAsk> {
  refuseNotUser()
  const result = await modAsks.decide(id, decision, now())
  if (!result.ok) {
    if (result.state === null) {
      throw new HttpError(404, 'No mod asked that')
    }
    throw new HttpError(409, `That ask is ${STANDING[result.state]}`)
  }
  const { ask } = result
  const allowed = decision === 'allow'
  await audit.record({
    actor: 'user',
    kind: allowed ? 'mod.ask_allowed' : 'mod.ask_denied',
    subject_type: 'mod',
    subject_id: ask.mod_id,
    summary: `${allowed ? 'Allowed' : 'Denied'}: ${ask.summary}`,
    detail: { ask: ask.id, op: ask.op },
  })
  if (allowed) {
    const outcome = await runAllowed(ask).then(
      (text) => ({ state: 'done' as const, text }),
      (e: unknown) => ({ state: 'failed' as const, text: e instanceof Error ? e.message : String(e) }),
    )
    await modAsks.finish(ask.id, outcome.state, outcome.text)
  }
  const current = await modAsks.get(ask.id, now())
  if (current === undefined) {
    throw new HttpError(404, 'No mod asked that')
  }
  return current
}

export const openModAsks = async (): Promise<ModAsk[]> => {
  refuseNotUser()
  return modAsks.open(now())
}
