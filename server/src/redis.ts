import { createClient } from '@redis/client'
import { DATABASE_URL, REDIS_URL } from './config.js'
import { databaseOf } from './pg.js'

/** Instances that share one Redis, such as scratch runs and tests, each keep to their own keys. */
const PREFIX = `seti:${databaseOf(DATABASE_URL)}:`

const MAX_RECONNECT_MS = 5000

const reconnectStrategy = (retries: number) => Math.min(100 * 2 ** retries, MAX_RECONNECT_MS)

/** Commands fail fast while Redis is away; a subscription waits for it instead. */
function clientOptions(failFast: boolean) {
  const common = { name: 'seti', disableOfflineQueue: failFast }
  if (REDIS_URL.startsWith('/')) {
    return { ...common, socket: { path: REDIS_URL, tls: false as const, reconnectStrategy } }
  }
  return { ...common, url: REDIS_URL, socket: { reconnectStrategy } }
}

let lastWarning = ''
let closing = false

function warn(e: unknown): void {
  const message = e instanceof Error ? e.message : String(e)
  if (!closing && message !== lastWarning) {
    lastWarning = message
    process.stderr.write(`redis: ${message}; caching and cross-process events wait until it is back\n`)
  }
}

function open(failFast: boolean) {
  closing = false
  const client = createClient(clientOptions(failFast))
  client.on('error', warn)
  client.on('ready', () => {
    if (lastWarning !== '') {
      lastWarning = ''
      process.stdout.write('redis: connected\n')
    }
  })
  client.connect().catch(warn)
  return client
}

type Client = ReturnType<typeof open>

/** How long the first calls wait for the first connection, so a restart still finds the cache. */
const FIRST_CONNECT_MS = 500

let commands: Client | null = null
let subscriber: Client | null = null
let firstConnect: Promise<boolean> | null = null

async function readyWithin(client: Client, ms: number): Promise<boolean> {
  if (client.isReady) {
    return true
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.off('ready', done)
      resolve(false)
    }, ms)
    function done() {
      clearTimeout(timer)
      resolve(true)
    }
    client.once('ready', done)
  })
}

/** The command client when Redis answers; null sends callers down their uncached path. */
async function ready(): Promise<Client | null> {
  if (REDIS_URL === 'off') {
    return null
  }
  commands ??= open(true)
  firstConnect ??= readyWithin(commands, FIRST_CONNECT_MS)
  if (!commands.isReady) {
    await firstConnect
  }
  return commands.isReady ? commands : null
}

/** Waits up to `ms` for Redis, for work that must not start without it. */
export async function redisReady(ms = 1000): Promise<boolean> {
  const client = await ready()
  return client !== null || (commands !== null && (await readyWithin(commands, ms)))
}

async function attempt<T>(fallback: T, run: (client: Client) => Promise<T>): Promise<T> {
  const client = await ready()
  if (client === null) {
    return fallback
  }
  try {
    return await run(client)
  } catch (e) {
    warn(e)
    return fallback
  }
}

const parse = (text: string | null): unknown => (text === null ? undefined : JSON.parse(text))

/** JSON values with a time to live; every failure reads as a miss and every write is best effort. */
export const cache = {
  get: async <T>(key: string): Promise<T | undefined> =>
    attempt(undefined, async (client) => parse(await client.get(PREFIX + key)) as T | undefined),
  /** One value per key, in key order, with misses as undefined. */
  getMany: async <T>(keys: readonly string[]): Promise<(T | undefined)[]> =>
    keys.length === 0
      ? []
      : attempt(
          keys.map(() => undefined),
          async (client) =>
            (await client.mGet(keys.map((key) => PREFIX + key))).map((text) => parse(text) as T | undefined),
        ),
  set: async (key: string, value: unknown, ttlSeconds: number): Promise<void> => {
    await attempt(undefined, async (client) => {
      await client.set(PREFIX + key, JSON.stringify(value), { expiration: { type: 'EX', value: ttlSeconds } })
    })
  },
  del: async (...keys: string[]): Promise<void> => {
    await attempt(undefined, async (client) => {
      await client.del(keys.map((key) => PREFIX + key))
    })
  },
  /** The cached value, or what `load` returns, cached for the next caller. */
  remember: async <T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> => {
    const known = await cache.get<T>(key)
    if (known !== undefined) {
      return known
    }
    const value = await load()
    await cache.set(key, value, ttlSeconds)
    return value
  },
  /** Claims a key for `ms` so one process among many does a refresh; alone, a process always may. */
  claim: async (key: string, ms: number): Promise<boolean> =>
    attempt(true, async (client) => {
      const reply = await client.set(PREFIX + key, String(process.pid), {
        condition: 'NX',
        expiration: { type: 'PX', value: ms },
      })
      return reply === 'OK'
    }),
}

/** The INFO reply of the Redis server, or null when Redis is off or away. */
export async function redisInfo(): Promise<string | null> {
  return attempt(null, async (client) => client.info())
}

/** Sends a message to every process that listens on the channel; dropped while Redis is away. */
export async function broadcast(channel: string, message: string): Promise<void> {
  await attempt(undefined, async (client) => {
    await client.publish(PREFIX + channel, message)
  })
}

/** Hands messages on channels matching `pattern` to the listener, resubscribing after reconnects. */
export function listen(pattern: string, listener: (channel: string, message: string) => void): void {
  if (REDIS_URL === 'off') {
    return
  }
  subscriber ??= open(false)
  subscriber
    .pSubscribe(PREFIX + pattern, (message, channel) => {
      listener(channel.slice(PREFIX.length), message)
    })
    .catch(warn)
}

/** Deletes every key of this instance, as a test run does when it ends. */
export async function clearCache(): Promise<void> {
  await attempt(undefined, async (client) => {
    for await (const keys of client.scanIterator({ MATCH: `${PREFIX}*`, COUNT: 500 })) {
      if (keys.length > 0) {
        await client.unlink(keys)
      }
    }
  })
}

/** Closes both clients; one still trying to connect is dropped at once instead. */
export async function closeRedis(): Promise<void> {
  const clients = [commands, subscriber].filter((client) => client !== null)
  commands = null
  subscriber = null
  firstConnect = null
  closing = true
  await Promise.allSettled(
    clients.map(async (client) => {
      if (client.isReady) {
        await client.close()
      } else {
        client.destroy()
      }
    }),
  )
}
