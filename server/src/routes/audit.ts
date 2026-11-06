import { auditQuery, type AuditStatus } from '@seti/shared'
import { Hono } from 'hono'
import { AUDIT_RETENTION_DAYS } from '../config.js'
import { ok, valid } from '../http.js'
import { auditEvents } from '../store/audit.js'

export const auditRoutes = new Hono()
  .get('/', valid('query', auditQuery), async (c) => ok(c, await auditEvents.page(c.req.valid('query'))))
  .get('/status', async (c) =>
    ok(c, { retention_days: AUDIT_RETENTION_DAYS, chain: await auditEvents.verify() } satisfies AuditStatus),
  )
