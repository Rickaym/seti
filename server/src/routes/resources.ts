import { cpuCapInput, memoryCapInput } from '@seti/shared'
import { Hono } from 'hono'
import { cpuCapSettings, updateCpuCap } from '../cpu-cap.js'
import { ok, validJson } from '../http.js'
import { memoryCapSettings, updateMemoryCap } from '../memory-cap.js'
import { resourceSampler } from '../resources.js'

export const resourceRoutes = new Hono()
  .get('/', async (c) => ok(c, await resourceSampler.current()))
  .get('/summary', async (c) => ok(c, await resourceSampler.summary()))
  .get('/memory', async (c) => ok(c, await memoryCapSettings()))
  .put('/memory', validJson(memoryCapInput), async (c) => ok(c, await updateMemoryCap(c.req.valid('json'))))
  .get('/cpu', async (c) => ok(c, await cpuCapSettings()))
  .put('/cpu', validJson(cpuCapInput), async (c) => ok(c, await updateCpuCap(c.req.valid('json'))))
