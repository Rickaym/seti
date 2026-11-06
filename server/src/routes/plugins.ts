import {
  installedPluginParams,
  installedPluginUpdateInput,
  marketplaceAddInput,
  marketplaceParams,
  pluginCatalogQuery,
  pluginInstallInput,
  pluginListQuery,
  pluginPreviewQuery,
  setiPluginInput,
  setiPluginParams,
  setiPluginUpdateInput,
} from '@seti/shared'
import { Hono } from 'hono'
import { notEa } from '../ea-guard.js'
import { ok, valid, validJson } from '../http.js'
import { pluginMarket } from '../plugin-market.js'
import { addDefaultPlugin, pluginCatalog, removeDefaultPlugin, setDefaultPluginEnabled } from '../plugins.js'
import { setiPlugins } from '../store/plugins.js'

const validId = valid('param', setiPluginParams)
const validPlugin = valid('param', installedPluginParams)
const validMarketplace = valid('param', marketplaceParams)
const userOnly = notEa('install, remove or change Claude Code plugins and marketplaces')

export const pluginRoutes = new Hono()
  .get('/', valid('query', pluginListQuery), async (c) =>
    ok(c, await pluginCatalog.list(c.req.valid('query').refresh === '1')),
  )
  .get('/defaults', async (c) => ok(c, await setiPlugins.list()))
  .post('/defaults', validJson(setiPluginInput), async (c) => ok(c, await addDefaultPlugin(c.req.valid('json').path)))
  .patch('/defaults/:id', validId, validJson(setiPluginUpdateInput), async (c) =>
    ok(c, await setDefaultPluginEnabled(c.req.valid('param').id, c.req.valid('json').enabled)),
  )
  .delete('/defaults/:id', validId, async (c) => {
    await removeDefaultPlugin(c.req.valid('param').id)
    return c.body(null, 204)
  })
  .use('/marketplaces', userOnly)
  .use('/marketplaces/*', userOnly)
  .use('/catalog', userOnly)
  .use('/catalog/*', userOnly)
  .use('/installed', userOnly)
  .use('/installed/*', userOnly)
  .get('/marketplaces', valid('query', pluginListQuery), async (c) =>
    ok(c, await pluginMarket.marketplaces(c.req.valid('query').refresh === '1')),
  )
  .post('/marketplaces', validJson(marketplaceAddInput), async (c) =>
    ok(c, await pluginMarket.addMarketplace(c.req.valid('json').source)),
  )
  .post('/marketplaces/:name/update', validMarketplace, async (c) =>
    ok(c, await pluginMarket.updateMarketplace(c.req.valid('param').name)),
  )
  .delete('/marketplaces/:name', validMarketplace, async (c) =>
    ok(c, await pluginMarket.removeMarketplace(c.req.valid('param').name)),
  )
  .get('/catalog', valid('query', pluginCatalogQuery), async (c) => {
    const { q, marketplace, refresh } = c.req.valid('query')
    return ok(c, await pluginMarket.catalog({ q, marketplace, refresh: refresh === '1' }))
  })
  .get('/catalog/preview', valid('query', pluginPreviewQuery), async (c) =>
    ok(c, await pluginMarket.preview(c.req.valid('query').id)),
  )
  .post('/installed', validJson(pluginInstallInput), async (c) =>
    ok(c, await pluginMarket.install(c.req.valid('json').id)),
  )
  .patch('/installed/:id', validPlugin, validJson(installedPluginUpdateInput), async (c) =>
    ok(c, await pluginMarket.setEnabled(c.req.valid('param').id, c.req.valid('json').enabled)),
  )
  .post('/installed/:id/update', validPlugin, async (c) => ok(c, await pluginMarket.update(c.req.valid('param').id)))
  .delete('/installed/:id', validPlugin, async (c) => ok(c, await pluginMarket.uninstall(c.req.valid('param').id)))
