import { userSettingsInput } from '@seti/shared'
import { Hono } from 'hono'
import { ok, validJson } from '../http.js'
import { saveTheme } from '../mods/themes.js'
import { currentSettings, saveName } from '../user-settings.js'

export const userRoutes = new Hono()
  .get('/', async (c) => ok(c, await currentSettings()))
  .put('/', validJson(userSettingsInput), async (c) => {
    const { name, theme } = c.req.valid('json')
    if (theme !== undefined) {
      await saveTheme(theme)
    }
    if (name !== undefined) {
      await saveName(name)
    }
    return ok(c, await currentSettings())
  })
