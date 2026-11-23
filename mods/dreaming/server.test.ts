import type { DreamNight, ModRouteHandler, ServerModApi } from '@seti/mod-api'
import { describe, expect, it, vi } from 'vitest'
import { dreamingServer } from './server.js'

const NIGHT: DreamNight = {
  night: '2026-11-24',
  zone: 'Europe/Istanbul',
  window_start: '2026-11-23T22:00:00.000Z',
  window_end: '2026-11-24T02:00:00.000Z',
  state: 'ended',
  runs: [],
  skipped: { nothing_new: 2 },
  cost_usd: 0,
}

function start() {
  const routes = new Map<string, ModRouteHandler>()
  const dreams = {
    night: vi.fn(async () => Promise.resolve(NIGHT)),
    shown: vi.fn(async () => Promise.resolve(false)),
    proposals: vi.fn(async () => Promise.resolve([])),
  }
  const api = {
    dreams,
    route: (method: string, path: string, handler: ModRouteHandler) => {
      routes.set(`${method} ${path}`, handler)
      return () => undefined
    },
  } as unknown as ServerModApi
  dreamingServer.server(api)
  return { routes, dreams }
}

const request = (query: Record<string, string>) => ({
  params: {},
  query,
  body: null,
  caller: { source: 'user' as const, agent: null },
})

describe('the Dreaming server half', () => {
  it('reads the night asked for, or the newest one when the date is not a date', async () => {
    const { routes, dreams } = start()
    expect((await routes.get('GET /night')?.(request({ night: '2026-11-24' })))?.body).toEqual(NIGHT)
    expect(dreams.night).toHaveBeenLastCalledWith('2026-11-24')
    await routes.get('GET /night')?.(request({ night: '../etc' }))
    expect(dreams.night).toHaveBeenLastCalledWith(undefined)
    expect((await routes.get('GET /waiting')?.(request({})))?.body).toEqual([])
  })

  it('says whether the Dreams entry shows, which it does not while Dreaming is off and unused', async () => {
    const { routes, dreams } = start()
    expect((await routes.get('GET /shown')?.(request({})))?.body).toEqual({ shown: false })
    dreams.shown.mockResolvedValueOnce(true)
    expect((await routes.get('GET /shown')?.(request({})))?.body).toEqual({ shown: true })
  })
})
