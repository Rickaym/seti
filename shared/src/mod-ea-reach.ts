import { z } from 'zod'
import type { ModContributions } from './mod-contributions.js'

/** Why the EA cannot do what a command or route offers, such as "the layout of one browser". */
export const eaReason = z.string().trim().min(1).max(200).optional()

/** Where a person runs a command; each also needs a way for the EA, or a reason it has none. */
const USER_SURFACES = ['palette', 'agentHeader', 'agentMenu', 'view'] as const

type Reach = Pick<ModContributions, 'commands' | 'routes'>

/** A route whose `command` names no command of the mod; the manifest is not valid then. */
export function unknownRouteCommand({ commands, routes }: Reach): string | undefined {
  const ids = new Set(commands.map((command) => command.id))
  const route = routes.find((entry) => entry.command !== undefined && !ids.has(entry.command))
  return route === undefined
    ? undefined
    : `The route ${route.method} ${route.path} names no command ${route.command ?? ''}`
}

/**
 * What a person can do through the mod that the EA cannot, with no reason given. Seti writes each
 * to the mod's log when it starts the mod; mod API 2.0 will refuse such a manifest.
 */
export function modEaReachWarnings({ commands, routes }: Reach): string[] {
  const forEa = new Set(commands.filter((command) => command.for.includes('ea')).map((command) => command.id))
  const warnings: string[] = []
  for (const command of commands) {
    const surface = USER_SURFACES.find((place) => command.for.includes(place))
    if (surface !== undefined && !forEa.has(command.id) && command.eaReason === undefined) {
      warnings.push(
        `The command ${command.id} is offered on the ${surface} but not to the EA: add "ea" to its for, or say why in eaReason`,
      )
    }
  }
  for (const route of routes) {
    if (route.method === 'GET' || route.eaReason !== undefined) {
      continue
    }
    const key = `${route.method} ${route.path}`
    if (route.command === undefined) {
      warnings.push(
        `The route ${key} names no command that does the same for the EA: set command, or say why in eaReason`,
      )
    } else if (!forEa.has(route.command)) {
      warnings.push(`The route ${key} names the command ${route.command}, which is not offered to the EA`)
    }
  }
  return warnings
}
