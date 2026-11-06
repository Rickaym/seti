import { modParams, type ModLiveInfo, type ModStatusItemInfo, type ModThemeTokensInfo } from '@seti/shared'
import { Hono } from 'hono'
import { HttpError, ok, valid } from '../http.js'
import { modHost } from '../mods/bundled.js'
import { modStatusItems } from '../mods/ops/basics.js'
import { modThemeTokens } from '../mods/theme-tokens.js'

/** The items running mods set, each as its manifest declares it; a mod that stopped shows none. */
function statusItems(): ModStatusItemInfo[] {
  return [...modStatusItems.entries()].flatMap(([key, item]) => {
    const manifest = modHost.get(item.mod)?.manifest ?? null
    const declared = manifest?.contributes.statusBar.find((entry) => entry.id === item.item)
    if (manifest === null || declared === undefined) {
      return []
    }
    const { id: mod, name: modName } = manifest
    return [{ key, mod, modName, title: declared.title, text: item.text, command: declared.command ?? null }]
  })
}

/** What running third-party mods show in Seti's chrome: status items and theme tokens. */
export const modLiveRoutes = new Hono()
  .get('/', (c) => ok(c, { status: statusItems() } satisfies ModLiveInfo))
  .get('/:id/themes', valid('param', modParams), (c) => {
    const tokens = modThemeTokens.get(c.req.valid('param').id)
    if (tokens === undefined) {
      throw new HttpError(404, 'That mod adds no themes now')
    }
    return ok(c, { css: tokens.css } satisfies ModThemeTokensInfo)
  })
