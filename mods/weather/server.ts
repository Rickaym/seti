import { defineMod } from '@seti/mod-api'
import { forecaster, forecastUrl, pointOf } from './forecast.js'
import manifest from './seti-mod.json' with { type: 'json' }

/** Looks up the weather near a point on Open-Meteo, cached for ten minutes. */
export const weatherServer = defineMod({
  manifest,
  server: (api) => {
    const near = forecaster(api, forecastUrl(api.env('URL')))
    api.route('GET', '/forecast', async ({ query }) => {
      const point = pointOf(query)
      if (point === null) {
        return { status: 400, body: 'Send lat from -90 to 90 and lon from -180 to 180' }
      }
      return { body: await near(point) }
    })
  },
})
