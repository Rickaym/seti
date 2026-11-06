import type { ModCommandCall } from '@seti/mod-api'
import {
  MOD_TASK_ARG,
  modCommandArgs,
  parseComposer,
  type ModActionResult,
  type ModCommand,
  type ModManifest,
} from '@seti/shared'
import { currentRequestSource } from '../access.js'
import { audit } from '../audit.js'
import { refuseMod } from '../ea-guard.js'
import { describeIssues, HttpError } from '../http.js'
import { modHost } from './bundled.js'
import type { HostedMod } from './host.js'
import { modCommands, setiCommandRefusal, type ModCommandEntry } from './points.js'
import { liveTask } from '../seti-tools/refs.js'

type Caller = ModCommandCall['caller']

/** Who runs the command, once their place is among the command's `for`; refuses everyone else. */
function callerFor(entry: ModCommandEntry): Caller {
  refuseMod('run mod commands')
  const source = currentRequestSource()
  const { command, modName } = entry
  const offered = (where: ModCommand['for'][number]) => {
    if (!command.for.includes(where)) {
      throw new HttpError(403, `${modName} does not offer ${command.title} to ${WHERE_NAMES[where]}`)
    }
  }
  switch (source?.via) {
    case 'ea':
      offered('ea')
      return { source: 'ea', agent: null }
    case 'agent':
      offered('agents')
      if (source.scope === 'self' && command.level !== 'self') {
        throw new HttpError(403, `${command.title} reaches past you, and your Seti control is Self`)
      }
      return { source: 'agent', agent: source.taskId }
    case 'session':
    case 'local':
    case 'public':
      if (!command.for.some((where) => USER_PLACES.has(where)) && !runBySlash(entry)) {
        throw new HttpError(403, `${modName} offers ${command.title} only to the EA and agents`)
      }
      return { source: 'user', agent: null }
    case 'device':
    case 'mod':
    case undefined:
      throw new HttpError(403, 'Only the user, the EA and agents run mod commands')
  }
}

const WHERE_NAMES = {
  palette: 'the user',
  agentHeader: 'the user',
  agentMenu: 'the user',
  agents: 'agents',
  ea: 'the EA',
  view: "the mod's views",
} as const

/** Places where the user runs a command in Seti's own UI. */
const USER_PLACES: ReadonlySet<ModCommand['for'][number]> = new Set(['palette', 'agentHeader', 'agentMenu'])

const runBySlash = ({ mod, command }: ModCommandEntry) =>
  modHost.get(mod)?.manifest?.contributes.slashCommands.some((slash) => slash.command === command.id) === true

const isOn = (mod: HostedMod) => mod.disposers !== null

/** The command an enabled mod answers; a known mod that is off says so. */
function entryOf(modId: string, action: string): ModCommandEntry {
  const entry = modCommands.get(`${modId}.${action}`)
  if (entry !== undefined) {
    return entry
  }
  const mod = modHost.get(modId)
  const manifest = mod?.manifest ?? null
  if (mod === undefined || manifest === null) {
    throw new HttpError(404, `Seti has no mod ${modId}`)
  }
  if (!manifest.contributes.commands.some((command) => command.id === action)) {
    throw new HttpError(404, `${manifest.name} has no command ${action}`)
  }
  throw new HttpError(409, isOn(mod) ? `${manifest.name} does not answer ${action}` : `${manifest.name} is off`)
}

/** The arguments as the manifest declares them, with task resolved to the agent's id. */
async function checkedArgs(command: ModCommand, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parsed = modCommandArgs(command).safeParse(raw)
  if (!parsed.success) {
    throw new HttpError(400, describeIssues(parsed.error))
  }
  const args: Record<string, unknown> = { ...parsed.data }
  const ref = args[MOD_TASK_ARG]
  if (typeof ref === 'string') {
    args[MOD_TASK_ARG] = (await liveTask(ref)).id
  }
  return args
}

async function withTimeout<T>(work: Promise<T>, command: ModCommand): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new HttpError(504, `${command.title} did not answer within ${String(command.timeoutSeconds)} seconds`))
    }, command.timeoutSeconds * 1000)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

/** The line Seti shows for an answer: the string, its text field, or Done. */
function textOf(result: unknown): string {
  if (typeof result === 'string') {
    return result
  }
  const text = typeof result === 'object' && result !== null ? (result as { text?: unknown }).text : undefined
  return typeof text === 'string' ? text : 'Done.'
}

/**
 * Runs a mod command for the user, the EA or an agent, each only where the manifest offers it,
 * with its arguments checked; one that changes something is audited as whoever asked.
 */
export async function runModAction(modId: string, action: string, raw: Record<string, unknown>) {
  const entry = entryOf(modId, action)
  const { command, modName } = entry
  const caller = callerFor(entry)
  const args = await checkedArgs(command, raw)
  const result = await withTimeout(entry.run({ args, caller }), command)
  if (command.changes) {
    await audit.record({
      actor: 'user',
      kind: 'mod.action_run',
      subject_type: 'mod',
      subject_id: modId,
      summary: `Ran ${command.title} of the ${modName} mod`,
      detail: { mod: modId, action, args: Object.keys(args) },
    })
  }
  return { mod: modId, action, result, text: textOf(result) } satisfies ModActionResult
}

/** Bundled mods that are off but would run, with their manifests. */
const offBundled = (): ModManifest[] =>
  modHost
    .list()
    .filter((mod) => mod.tier === 'bundled' && mod.problem === null && !isOn(mod))
    .flatMap((mod) => (mod.manifest === null ? [] : [mod.manifest]))

/**
 * Why the prompt cannot go to the agent: a command Seti answers itself, or one of a bundled mod
 * that is off, which never goes to Claude Code either; null when it can.
 */
export function slashRefusal(prompt: string): string | null {
  const own = setiCommandRefusal(prompt)
  const input = parseComposer(prompt)
  if (own !== null || input.mode !== 'slash') {
    return own
  }
  const name = input.name.toLowerCase()
  const off = offBundled().find((manifest) => manifest.contributes.slashCommands.some((slash) => slash.name === name))
  return off === undefined ? null : `/${name} belongs to ${off.name}, which is off; turn it on in Settings, Mods`
}
