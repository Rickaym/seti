import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Resolved } from './policy/types.js'

/** Errors that mean a path does not exist yet, so its parent says where it would lead. */
const MISSING = new Set(['ENOENT', 'ENOTDIR'])

const codeOf = (e: unknown) => (e instanceof Error && 'code' in e ? String(e.code) : '')

/**
 * Where a path leads on disk: its deepest existing ancestor resolved with the rest appended, or
 * null when it cannot be resolved, as for a symlink loop.
 */
async function leadsTo(absolute: string): Promise<string | null> {
  const rest: string[] = []
  let head = absolute
  for (;;) {
    try {
      return path.join(await realpath(head), ...rest)
    } catch (e) {
      const parent = path.dirname(head)
      if (!MISSING.has(codeOf(e))) {
        return null
      }
      if (parent === head) {
        return absolute
      }
      rest.unshift(path.basename(head))
      head = parent
    }
  }
}

interface Root {
  given: string
  real: string
}

/** A real path written under the root as the agent names it, so a link above the root counts not. */
function asNamed(real: string, roots: readonly Root[]): string {
  const root = roots.find((one) => real === one.real || real.startsWith(`${one.real}/`))
  return root === undefined ? real : root.given + real.slice(root.real.length)
}

/**
 * Where each of the paths leads on disk, for Seti's evaluator to check beside the path as given.
 * The roots (working directories and home) count as named: only a link below one of them, or
 * outside them all, changes where a path leads. Holds only the paths that lead elsewhere.
 */
export async function resolvePaths(paths: readonly string[], roots: readonly string[]): Promise<Resolved> {
  if (paths.length === 0) {
    return new Map()
  }
  const known = await Promise.all(roots.map(async (given) => ({ given, real: (await leadsTo(given)) ?? given })))
  const deepest = known.toSorted((a, b) => b.real.length - a.real.length)
  const resolved = new Map<string, string | null>()
  await Promise.all(
    paths.map(async (given) => {
      const real = await leadsTo(given)
      const named = real === null ? null : asNamed(real, deepest)
      if (named !== given) {
        resolved.set(given, named)
      }
    }),
  )
  return resolved
}
