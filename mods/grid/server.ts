import { defineMod } from '@seti/mod-api'
import manifest from './seti-mod.json' with { type: 'json' }

/** Serves each workspace's grid layout from Seti's own table, which core checks on every write. */
export const gridServer = defineMod({
  manifest,
  server: (api) => {
    const { grids } = api.workspaces
    api.route('GET', '/layouts', async () => ({ body: await grids.list() }))
    api.route('PUT', '/layouts/:workspace_id', async ({ params, body, caller }) => ({
      body: await grids.put(params.workspace_id ?? '', body, caller),
    }))
  },
})
