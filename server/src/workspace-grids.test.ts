import { sampleServer } from '@seti/mod-sample/server'
import { modManifest, type ModCapabilityName, type Workspace, type WorkspaceGrid } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { serverApi } from './mods/api.js'
import { modHost } from './mods/bundled.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const app = createApp()

beforeAll(async () => {
  await modHost.start()
})

afterAll(() => {
  modHost.stopAll()
})

interface Reply<T> {
  status: number
  data: T
}

async function send<T>(method: string, url: string, body?: unknown, auth = USER_AUTH): Promise<Reply<T>> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (res.status === 204) {
    return { status: 204, data: undefined as T }
  }
  return { status: res.status, data: ((await res.json()) as { data: T }).data }
}

async function create(name: string): Promise<Workspace> {
  const reply = await send<Workspace>('POST', '/workspaces', { name })
  expect(reply.status).toBe(200)
  return reply.data
}

describe('workspace grids, served by the grid mod', () => {
  const panel = { i: 'p1', agent: 'agent-a', x: 0, y: 0, w: 6, h: 24 }
  const grids = async () => (await send<WorkspaceGrid[]>('GET', '/mods/grid/layouts')).data

  it('stores a layout per workspace, a revision on per save, the latest save winning', async () => {
    const own = await create('Grid owner')
    expect((await grids()).some((grid) => grid.workspace_id === own.id)).toBe(false)
    const first = await send<WorkspaceGrid>('PUT', `/mods/grid/layouts/${own.id}`, {
      layout: { panels: [panel], locked: false },
    })
    expect(first).toMatchObject({ status: 200, data: { workspace_id: own.id, revision: 1 } })
    expect(first.data.layout.perScreen).toBeNull()
    const layout = { panels: [panel, { ...panel, i: 'p2', agent: null, x: 6 }], locked: true, perScreen: 3 }
    const second = await send<WorkspaceGrid>('PUT', `/mods/grid/layouts/${own.id}`, { layout }, EA_AUTH)
    expect(second.data).toMatchObject({ revision: 2, layout })
    expect((await grids()).find((grid) => grid.workspace_id === own.id)).toEqual(second.data)
  })

  it('refuses a layout off the grid and an unknown workspace', async () => {
    const own = await create('Grid checks')
    const put = async (layout: unknown, id = own.id) => send('PUT', `/mods/grid/layouts/${id}`, { layout })
    expect((await put({ panels: [{ ...panel, x: 12 }], locked: false })).status).toBe(400)
    expect((await put({ panels: [{ ...panel, w: 0 }], locked: false })).status).toBe(400)
    expect((await put({ panels: [{ ...panel, i: '' }], locked: false })).status).toBe(400)
    expect((await put({ panels: [panel] })).status).toBe(400)
    expect((await put({ panels: [panel], locked: false, perScreen: 7 })).status).toBe(400)
    expect((await put({ panels: [panel], locked: false }, 'missing')).status).toBe(404)
    expect((await grids()).some((grid) => grid.workspace_id === own.id)).toBe(false)
  })

  it('keeps terminal tiles, which only the user adds', async () => {
    const own = await create('Grid terminals')
    const tile = { ...panel, i: 'p2', agent: null, x: 6, terminal: { id: 't1', name: 'Terminal', task: null } }
    const layout = { panels: [panel, tile], locked: false, perScreen: null }
    const put = async (body: unknown, auth?: typeof EA_AUTH) =>
      send<WorkspaceGrid>('PUT', `/mods/grid/layouts/${own.id}`, { layout: body }, auth)
    expect((await put(layout, EA_AUTH)).status).toBe(403)
    expect((await put(layout)).data.layout).toEqual(layout)
    const moved = { ...layout, panels: [panel, { ...tile, x: 0, y: 24 }] }
    expect((await put(moved, EA_AUTH)).status).toBe(200)
    const other = { ...tile, i: 'p3', terminal: { ...tile.terminal, id: 't2' } }
    expect((await put({ ...layout, panels: [panel, tile, other] }, EA_AUTH)).status).toBe(403)
    expect((await put({ ...layout, panels: [{ ...tile, terminal: { ...tile.terminal, name: '' } }] })).status).toBe(400)
    expect((await grids()).find((grid) => grid.workspace_id === own.id)?.layout).toEqual(moved)
  })

  it('deletes a layout with its workspace', async () => {
    const gone = await create('Grid gone')
    await send('PUT', `/mods/grid/layouts/${gone.id}`, { layout: { panels: [panel], locked: false } })
    expect((await grids()).some((grid) => grid.workspace_id === gone.id)).toBe(true)
    expect((await send('DELETE', `/workspaces/${gone.id}`)).status).toBe(204)
    expect((await grids()).some((grid) => grid.workspace_id === gone.id)).toBe(false)
  })
})

describe('the workspaces.layout mod service', () => {
  const grids = (grants: ModCapabilityName[]) =>
    serverApi({
      manifest: { ...modManifest.parse(sampleServer.manifest), id: 'layouts' },
      grants,
      track: (dispose) => dispose,
    }).workspaces.grids
  const panel = { i: 'p1', agent: 'agent-a', x: 0, y: 0, w: 6, h: 24 }
  const user = { source: 'user', agent: null } as const

  it('needs the capability, checks layout and workspace, and keeps new tiles for the user', async () => {
    const own = await create('Mod layouts')
    const tile = { ...panel, i: 'p2', agent: null, x: 6, terminal: { id: 't9', name: 'Terminal', task: null } }
    const layout = { panels: [panel, tile], locked: false, perScreen: null }
    const granted = grids(['workspaces.layout'])
    await expect(grids([]).list()).rejects.toThrow('was not granted workspaces.layout')
    await expect(granted.put(own.id, { layout }, { source: 'ea', agent: null })).rejects.toMatchObject({ status: 403 })
    await expect(granted.put(own.id, { layout: { panels: 'none' } }, user)).rejects.toMatchObject({ status: 400 })
    await expect(granted.put('missing', { layout }, user)).rejects.toMatchObject({ status: 404 })
    const saved = await granted.put(own.id, { layout }, user)
    expect(saved).toMatchObject({ workspace_id: own.id, revision: 1, layout })
    expect((await granted.list()).find((grid) => grid.workspace_id === own.id)).toEqual(saved)
  })
})
