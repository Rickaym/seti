const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype

type Key = string | number

const keyOf = (value: unknown): Key | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const { id } = value
  return typeof id === 'string' || typeof id === 'number' ? id : undefined
}

/** Earlier items to compare each new one with: the one with its id, else the one at its index. */
function partners(prev: readonly unknown[], next: readonly unknown[]): (index: number) => unknown {
  const keys = prev.map(keyOf)
  if (keys.includes(undefined)) {
    return (index) => prev[index]
  }
  const byKey = new Map(keys.map((key, index) => [key, prev[index]]))
  return (index) => {
    const key = keyOf(next[index])
    return key === undefined ? prev[index] : byKey.get(key)
  }
}

function shareArray(prev: readonly unknown[], next: readonly unknown[]): readonly unknown[] {
  const partner = partners(prev, next)
  let same = prev.length === next.length
  const out = next.map((item, index) => {
    const shared = shareEqual(partner(index), item)
    same &&= shared === prev[index]
    return shared
  })
  return same ? prev : out
}

function shareRecord(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(next)
  let same = keys.length === Object.keys(prev).length
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const shared = shareEqual(prev[key], next[key])
    out[key] = shared
    same &&= Object.hasOwn(prev, key) && shared === prev[key]
  }
  return same ? prev : out
}

/** `next`, with each part that deep-equals its match in `prev` swapped for that same object. */
export function shareEqual<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) {
    return next
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    return shareArray(prev, next) as T
  }
  if (isRecord(prev) && isRecord(next)) {
    return shareRecord(prev, next) as T
  }
  return next
}
