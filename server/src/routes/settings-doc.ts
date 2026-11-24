import { Hono } from 'hono'
import { ok } from '../http.js'
import { settingsDoc, settingsDocJsonSchema } from '../settings-doc/document.js'

/** Every setting as one JSON document and its JSON Schema; read only. */
export const settingsDocRoutes = new Hono()
  .get('/', async (c) => ok(c, await settingsDoc()))
  .get('/schema', async (c) => ok(c, await settingsDocJsonSchema()))
