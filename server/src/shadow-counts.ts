import type { PolicyShadowCount } from '@seti/shared'
import { policyShadow } from './store/policy-shadow.js'

const today = () => new Date().toISOString().slice(0, 10)

/** Counts a call a node's shadow compared, or one it could not decide, without waiting on it. */
export function countShadow(count: PolicyShadowCount | null): void {
  const day = today()
  const saved = count === null ? policyShadow.failed(day) : policyShadow.count(count, day)
  saved.catch((e: unknown) => {
    process.stderr.write(`policy shadow: count not saved: ${e instanceof Error ? e.name : 'error'}\n`)
  })
}
