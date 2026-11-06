import { isIPv6 } from 'node:net'
import type { Context } from 'hono'

const KEYS_MAX = 10_000

/** A sliding window of `limit` hits per key; take() is false once a key has used them up. */
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>()
  return {
    /** Whether the key has used up its hits, without taking one. */
    full: (key: string, at: number = Date.now()): boolean =>
      (hits.get(key) ?? []).filter((t) => t > at - windowMs).length >= limit,
    take: (key: string, at: number = Date.now()): boolean => {
      const recent = (hits.get(key) ?? []).filter((t) => t > at - windowMs)
      const allowed = recent.length < limit
      if (allowed) {
        recent.push(at)
      }
      hits.delete(key)
      hits.set(key, recent)
      if (hits.size > KEYS_MAX) {
        const oldest = hits.keys().next().value
        if (oldest !== undefined) {
          hits.delete(oldest)
        }
      }
      return allowed
    },
  }
}

/** The eight 16-bit groups of an IPv6 address, with `::` filled in. */
function ipv6Groups(address: string): string[] {
  const [head = '', tail] = address.split('::')
  const left = head === '' ? [] : head.split(':')
  if (tail === undefined) {
    return left
  }
  const right = tail === '' ? [] : tail.split(':')
  return [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right]
}

/** IPv4 clients by address; IPv6 ones by their /64, which one host commonly holds whole. */
export function clientNetwork(ip: string): string {
  const address = (
    ip
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .split('%')[0] ?? ''
  ).trim()
  if (!isIPv6(address)) {
    return address
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1]
  if (mapped !== undefined) {
    return mapped
  }
  const prefix = ipv6Groups(address)
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
  return `${prefix.join(':')}::/64`
}

/** The address a public request came from, as the tunnel reports it. */
export const clientAddress = (c: Context): string | null =>
  (c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0])?.trim() ?? null

/** The rate limit key of a request's client; loopback callers share one. */
export function clientKey(c: Context, publicHost: boolean): string {
  if (!publicHost) {
    return 'loopback'
  }
  const address = clientAddress(c)
  return address === null ? 'public' : clientNetwork(address)
}

/** Refusals of unauthenticated callers reach the audit log at most this often per client. */
const refusalAudits = rateLimiter(20, 10 * 60_000)

export const mayAuditRefusal = (key: string) => refusalAudits.take(key)
