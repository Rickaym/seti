import { defineMod, type UiModApi } from '@seti/mod-api'
import { useMemo } from 'react'
import { type BandSettings, DaylightBand } from './DaylightBand'
import { parseLocation } from './location'
import { forgetLegacyWeather, legacyWeatherOff } from './preview'
import manifest from './seti-mod.json' with { type: 'json' }
import { forecastsOf } from './useWeather'

/** Daylight alone until the settings load, so a band with the weather off never looks it up. */
const LOADING: BandSettings = { weather: false, units: 'C', location: null }

function bandSettings(values: Record<string, unknown> | null): BandSettings {
  if (values === null) {
    return LOADING
  }
  return {
    weather: values.weather !== false,
    units: values.units === 'Fahrenheit' ? 'F' : 'C',
    location: typeof values.location === 'string' ? parseLocation(values.location) : null,
  }
}

const bandView = (api: UiModApi) => {
  const forecasts = forecastsOf(api)
  return function WeatherBand() {
    const values = api.useSettings()
    const settings = useMemo(() => bandSettings(values), [values])
    return <DaylightBand forecasts={forecasts} settings={settings} />
  }
}

/** Moves the Weather choice this browser kept to the server once, then forgets it. */
async function moveLegacyChoice(api: UiModApi): Promise<void> {
  if (legacyWeatherOff()) {
    await api.saveSettings({ weather: false })
  }
  forgetLegacyWeather()
}

/** The daylight band across the header, with the weather where the user is. */
export const weatherUi = defineMod({
  manifest,
  ui: (api) => {
    api.registerView({ id: 'band', view: bandView(api) })
    void moveLegacyChoice(api).catch(() => undefined)
  },
})
