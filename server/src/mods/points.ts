import type { ModCommandCall, ModRouteHandler, ModStreamHandler } from '@seti/mod-api'
import {
  NOTIFY_KINDS,
  parseComposer,
  Registry,
  type ComposerCommand,
  type ModAuditKind,
  type ModCommand,
  type ModManifest,
} from '@seti/shared'

/** A slash command an enabled mod answers, which never reaches the agent as a prompt. */
export interface SetiSlashCommand {
  command: ComposerCommand
  /** The mod that added it. */
  mod: string
  /** Why sending it to the agent is refused. */
  refusal: string
}

export const slashCommands = new Registry<SetiSlashCommand>('slash command', (entry) => entry.command.name)

/** The slash commands enabled mods answer, as the composer lists them. */
export const setiCommands = (): ComposerCommand[] => slashCommands.list().map((entry) => entry.command)

/** Why the prompt cannot go to the agent: it is a command Seti answers itself; null when it can. */
export function setiCommandRefusal(prompt: string): string | null {
  const input = parseComposer(prompt)
  return input.mode === 'slash' ? (slashCommands.get(input.name.toLowerCase())?.refusal ?? null) : null
}

/** A command an enabled mod's server half answers, keyed `<mod>.<command>`. */
export interface ModCommandEntry {
  mod: string
  modName: string
  command: ModCommand
  /** Runs the handler as the mod, within its grants. */
  run: (call: ModCommandCall) => Promise<unknown>
}

export const modCommands = new Registry<ModCommandEntry>('command', (entry) => `${entry.mod}.${entry.command.id}`)

/** A kind of notification: Seti's own about agents, or one a mod raises as `<mod>.<kind>`. */
export interface NotifyKindEntry {
  kind: string
  title: string
  mod: string | null
  /** On until the user turns it off. */
  default: boolean
}

export const notifyKinds = new Registry<NotifyKindEntry>('notification kind', (entry) => entry.kind)

const CORE_NOTIFY_TITLES = { finished: 'Turn finished', needs_you: 'Needs you', ea: 'EA' } as const

for (const kind of NOTIFY_KINDS) {
  notifyKinds.register({ kind, title: CORE_NOTIFY_TITLES[kind], mod: null, default: true })
}

/** Audit kinds an enabled mod declared; Seti records no other `mod.<id>.<kind>`. */
export const modAuditKinds = new Registry<{ kind: ModAuditKind; mod: string }>('audit kind', (entry) => entry.kind)

type RouteMethod = ModManifest['contributes']['routes'][number]['method']

/** A route a mod answers under /api/mods/<id>/, with the handler its server half gave. */
export type ModRouteEntry = {
  mod: string
  method: RouteMethod
  /** The path under the mod's prefix, such as `/items/:id`. */
  path: string
  /** Answers in the public demo; nothing a mod adds answers there unless it says so. */
  demo: boolean
} & ({ stream: false; handle: ModRouteHandler } | { stream: true; handle: ModStreamHandler })

const routeKeyOf = (mod: string, method: string, path: string) => `${method} /api/mods/${mod}${path}`

export const modRouteEntries = new Registry<ModRouteEntry>('route', (entry) =>
  routeKeyOf(entry.mod, entry.method, entry.path),
)

function decoded(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

/** The params of a concrete path when it fits the pattern, such as `/items/:id`; else null. */
function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/')
  const have = path.split('/')
  if (want.length !== have.length) {
    return null
  }
  const params: Record<string, string> = {}
  for (const [i, part] of want.entries()) {
    const given = have[i] ?? ''
    const value = part.startsWith(':') && given !== '' ? decoded(given) : null
    if (part.startsWith(':') && value !== null) {
      params[part.slice(1)] = value
    } else if (part !== given) {
      return null
    }
  }
  return params
}

/** The route of an enabled mod that answers the request, with its params; null when none does. */
export function findModRoute(
  mod: string,
  method: string,
  path: string,
): { route: ModRouteEntry; params: Record<string, string> } | null {
  for (const route of modRouteEntries.list()) {
    const params = route.mod === mod && route.method === method ? matchPath(route.path, path) : null
    if (params !== null) {
      return { route, params }
    }
  }
  return null
}

/** Whether the request reaches a route an enabled mod marked for the public demo. */
export function demoModRoute(method: string, path: string): boolean {
  const [, mod = '', ...rest] = /^\/api\/mods\/([^/]+)(\/.*)$/.exec(path) ?? []
  return findModRoute(mod, method === 'HEAD' ? 'GET' : method, rest.join(''))?.route.demo === true
}
