import { defineMod } from '@seti/mod-api'
import manifest from './seti-mod.json' with { type: 'json' }

const FIRST_LIMIT = 200
const LIMIT_MAX = 500
const COMMIT = /^[0-9a-f]{40}$/

/** The `limit` of a changelog read, 200 without one; null when it is not 1 to 500. */
function limitOf(text: string | undefined): number | null {
  const limit = text === undefined ? FIRST_LIMIT : Number(text)
  return Number.isInteger(limit) && limit >= 1 && limit <= LIMIT_MAX ? limit : null
}

const commitOf = (body: unknown): string | null => {
  const commit: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'commit') : null
  return typeof commit === 'string' && COMMIT.test(commit) ? commit : null
}

/** Seti's changelog and update check; notes each deploy once it runs. */
export const whatsNewServer = defineMod({
  manifest,
  server: async (api) => {
    api.route('GET', '/changelog', async ({ query }) => {
      const limit = limitOf(query.limit)
      if (limit === null) {
        return { status: 400, body: `A limit is a whole number from 1 to ${String(LIMIT_MAX)}` }
      }
      return { body: await api.version.changelog(limit) }
    })
    api.route('GET', '/status', async () => ({ body: await api.version.status() }))
    api.route('GET', '/update', async () => ({ body: await api.version.update() }))
    api.route('POST', '/seen', async ({ body }) => {
      const commit = commitOf(body)
      if (commit === null) {
        return { status: 400, body: 'Send a full commit hash' }
      }
      await api.version.markSeen(commit)
      return { body: await api.version.status() }
    })
    await api.version.start()
  },
})
