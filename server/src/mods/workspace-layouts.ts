import type { ModWorkspaces } from '@seti/mod-api'
import { gridLayoutInput } from '@seti/shared'
import { HttpError } from '../http.js'
import { workspaceGridRows } from '../store/workspaces.js'
import { saveWorkspaceGrid } from '../workspace-grids.js'
import { requireOp } from './capabilities.js'

/** The workspaces.layout capability: each workspace's panel layout, checked and stored by Seti. */
export function workspacesApi(run: <T>(fn: () => Promise<T>) => Promise<T>): ModWorkspaces {
  return {
    grids: {
      list: async () =>
        run(async () => {
          requireOp('workspaces.layout')
          return workspaceGridRows.list()
        }),
      put: async (workspaceId, body, caller) =>
        run(async () => {
          requireOp('workspaces.layout')
          const parsed = gridLayoutInput.safeParse(body)
          if (!parsed.success) {
            throw new HttpError(400, 'Send a layout as { layout }')
          }
          return saveWorkspaceGrid(workspaceId, parsed.data.layout, caller.source !== 'user')
        }),
    },
  }
}
