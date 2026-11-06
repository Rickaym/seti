import type { APIRequestContext } from '@playwright/test'
import type { Envelope } from '@seti/shared'
import { seedChannels } from './channels.js'
import { seedPlan } from './seed.js'
import type { Sources } from './sources.js'
import { seedEaChat, type SeedApi } from '../../server/src/demo/content/flows.js'
import { seedTeamChat, stampEaChat } from '../../server/src/store/demo-seed.js'
import { openSeedDb } from '../tests/support/db.js'
import { EA_HEADERS } from '../tests/support/env.js'

/** The worker's server through the page's request context, as the user or as the EA. */
function seedApi(request: APIRequestContext, baseURL: string): SeedApi {
  return {
    call: async (method, path, body, asEa = false) => {
      const response = await request.fetch(path, {
        method,
        ...(body === undefined ? {} : { data: body }),
        headers: asEa ? EA_HEADERS : {},
      })
      if (!response.ok()) {
        throw new Error(`${method} ${path}: ${await response.text()}`)
      }
      return ((await response.json()) as Envelope<unknown>).data
    },
    deliver: async (path, body, signature) => {
      await fetch(new URL(path, baseURL), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-seti-signature': signature },
        body,
      })
    },
  }
}

export async function seedExtras(request: APIRequestContext, baseURL: string, sources: Sources): Promise<void> {
  const db = openSeedDb()
  const plan = seedPlan(db)
  await seedTeamChat(plan)
  await seedChannels(request, baseURL, sources)
  await seedEaChat(seedApi(request, baseURL))
  await stampEaChat(plan)
  await db.close()
}
