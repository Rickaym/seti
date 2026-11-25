/** A plain JSON object, as opposed to an array or a scalar. */
export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * What turns `from` into `to`, as a merge patch: objects recurse, a key `to` lacks reads null,
 * and an array or a scalar that differs is carried whole; undefined when nothing differs.
 */
export function diffPatch(from: unknown, to: unknown): unknown {
  if (!isJsonObject(from) || !isJsonObject(to)) {
    return same(from, to) ? undefined : to
  }
  const changed: [string, unknown][] = []
  for (const [key, value] of Object.entries(to)) {
    const part = Object.hasOwn(from, key) ? diffPatch(from[key], value) : value
    if (part !== undefined) {
      changed.push([key, part])
    }
  }
  for (const key of Object.keys(from)) {
    if (!Object.hasOwn(to, key)) {
      changed.push([key, null])
    }
  }
  return changed.length === 0 ? undefined : Object.fromEntries(changed)
}

/** A path in the document, one key per step, since keys such as host names may hold dots. */
export type DocPath = readonly string[]

/** A path as people read it, such as `agents.lifecycle.dreaming.model`. */
export const pathText = (path: DocPath) => path.join('.')

/** The path of each value a merge patch sets; an empty object counts as one value. */
export function patchPaths(patch: unknown, prefix: DocPath = []): DocPath[] {
  if (!isJsonObject(patch) || Object.keys(patch).length === 0) {
    return prefix.length === 0 ? [] : [prefix]
  }
  return Object.entries(patch).flatMap(([key, value]) => patchPaths(value, [...prefix, key]))
}

/** The paths where a document differs from its defaults. */
export const modifiedPaths = (doc: unknown, defaults: unknown): DocPath[] => patchPaths(diffPatch(defaults, doc))
