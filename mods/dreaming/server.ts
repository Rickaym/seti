import { defineMod, type DreamNight, type DreamProposal } from '@seti/mod-api'
import manifest from './seti-mod.json' with { type: 'json' }

const NIGHT = /^\d{4}-\d{2}-\d{2}$/

/** What the Dreams view reads: a night, and the clean-ups that wait for the user. */
export const dreamingServer = defineMod({
  manifest,
  server: (api) => {
    api.route('GET', '/night', async ({ query }) => {
      const night: DreamNight | null = await api.dreams.night(NIGHT.test(query.night ?? '') ? query.night : undefined)
      return { body: night }
    })
    api.route('GET', '/shown', async () => ({ body: { shown: await api.dreams.shown() } }))
    api.route('GET', '/waiting', async () => {
      const waiting: DreamProposal[] = await api.dreams.proposals()
      return { body: waiting }
    })
  },
})
