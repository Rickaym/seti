import { defineMod } from '@seti/mod-api'
import manifest from './seti-mod.json' with { type: 'json' }

const COUNT = 'count'

const countOf = (value: unknown) => (typeof value === 'number' ? value : 0)

/** Greets with its setting, keeps a count in its own storage and answers its two commands. */
export const sampleServer = defineMod({
  manifest,
  server: (api) => {
    api.route('GET', '/hello', async () => {
      const settings = await api.settings.get()
      const greeting = typeof settings.greeting === 'string' ? settings.greeting : ''
      return { body: { text: settings.loud === true ? greeting.toUpperCase() : greeting } }
    })
    const count = async () => {
      const next = countOf(await api.storage.get(COUNT)) + 1
      await api.storage.set(COUNT, next)
      await api.audit('counted', `The sample counted to ${String(next)}`, { count: next })
      return next
    }
    api.route('POST', '/count', async () => ({ body: { count: await count() } }))
    api.registerCommand('count', async () => {
      const next = await count()
      return { count: next, text: `The sample counted to ${String(next)}` }
    })
    api.registerCommand('wave', async ({ args, caller }) => {
      const note = typeof args.note === 'string' && args.note !== '' ? `: ${args.note}` : ''
      return Promise.resolve(`The sample waved at ${String(args.task)} for the ${caller.source}${note}`)
    })
  },
})
