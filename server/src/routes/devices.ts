import {
  androidAppInput,
  deviceNameInput,
  devicePairInput,
  deviceWidgetInput,
  PAIR_PAGE_PATH,
  type DevicePaired,
  type PairingCode,
} from '@seti/shared'
import { Hono, type Context } from 'hono'
import { currentPublicHost } from '../access.js'
import { audit } from '../audit.js'
import type { PublicAccess } from '../config.js'
import { androidAppSettings, createPairingCode, deviceInfo, pairDevice } from '../devices.js'
import { notEa, refuseAgent } from '../ea-guard.js'
import { fail, HttpError, ok, validJson } from '../http.js'
import { clientAddress, clientKey, mayAuditRefusal, rateLimiter } from '../rate-limit.js'
import { androidAppRows, deviceRows, type DeviceRow } from '../store/devices.js'

const WINDOW_MS = 10 * 60_000
/** Pairing attempts per client per ten minutes; no shared cap anyone could drain. */
const perClient = rateLimiter(10, WINDOW_MS)

const clientOf = (c: Context) => clientKey(c, currentPublicHost() !== null)

/** Records a refused pairing or device proof, at most a few per client. */
async function auditRefusal(c: Context, kind: 'pair' | 'proof', reason: string): Promise<void> {
  if (!mayAuditRefusal(clientOf(c))) {
    return
  }
  const what = kind === 'pair' ? 'a device pairing' : 'a device proof'
  await audit.record({
    actor: 'user',
    kind: kind === 'pair' ? 'system.device_pair_failed' : 'system.device_proof_refused',
    subject_type: 'system',
    summary: `Refused ${what} for ${c.req.path}: ${reason}`,
    detail: { ip: clientAddress(c), path: c.req.path, reason },
  })
}

export const auditRefusedProof = async (c: Context, reason: string) => auditRefusal(c, 'proof', reason)

async function deviceOf(c: Context): Promise<DeviceRow> {
  const row = await deviceRows.get(c.req.param('id') ?? '')
  if (row === undefined) {
    throw new HttpError(404, 'No such device')
  }
  return row
}

/** Paired devices: the app pairs with a one-time code; Settings lists, renames and revokes them. */
export function deviceRoutes(access: PublicAccess | null): Hono {
  return new Hono()
    .use('*', notEa('pair, rename or revoke devices'))
    .post('/pair', validJson(devicePairInput), async (c) => {
      if (!perClient.take(clientOf(c))) {
        return fail(c, 429, 'Too many attempts', 'Too many pairing attempts; wait a few minutes and try again')
      }
      let row: DeviceRow
      try {
        row = await pairDevice(c.req.valid('json'))
      } catch (e) {
        if (e instanceof HttpError) {
          await auditRefusal(c, 'pair', e.message)
        }
        throw e
      }
      const device = deviceInfo(row)
      await audit.record({
        actor: 'user',
        kind: 'system.device_paired',
        subject_type: 'system',
        subject_id: row.id,
        summary: `Paired the ${device.platform} device "${row.name}"`,
        detail: { name: row.name, platform: device.platform, scopes: device.scopes },
      })
      return ok(c, { device_id: row.id, scopes: device.scopes } satisfies DevicePaired)
    })
    .get('/', async (c) => ok(c, (await deviceRows.list()).map(deviceInfo)))
    .post('/pairing', async (c) => {
      const { code, expires_at } = await createPairingCode()
      const origin = access?.origin ?? `http://${c.req.header('host') ?? 'localhost'}`
      await audit.record({
        actor: 'user',
        kind: 'system.pairing_code_created',
        subject_type: 'system',
        summary: 'Made a device pairing code',
        detail: { expires_at },
      })
      return ok(c, { code, url: `${origin}${PAIR_PAGE_PATH}#code=${code}`, expires_at } satisfies PairingCode)
    })
    .patch('/:id', validJson(deviceNameInput), async (c) => {
      const row = await deviceOf(c)
      const { name } = c.req.valid('json')
      await deviceRows.rename(row.id, name)
      await audit.record({
        actor: 'user',
        kind: 'system.device_renamed',
        subject_type: 'system',
        subject_id: row.id,
        summary: `Renamed the device "${row.name}" to "${name}"`,
        detail: { name, previous_name: row.name },
      })
      return ok(c, deviceInfo({ ...row, name }))
    })
    .put('/:id/widget', validJson(deviceWidgetInput), async (c) => {
      refuseAgent('change what a phone widget shows')
      const row = await deviceOf(c)
      const { show_names } = c.req.valid('json')
      await deviceRows.showNames(row.id, show_names)
      await audit.record({
        actor: 'user',
        kind: 'system.device_widget_changed',
        subject_type: 'system',
        subject_id: row.id,
        summary: `${show_names ? 'Showed' : 'Hid'} agent names on the widgets of "${row.name}"`,
        detail: { name: row.name, show_names },
      })
      return ok(c, deviceInfo({ ...row, show_names }))
    })
    .delete('/:id', async (c) => {
      const row = await deviceOf(c)
      await deviceRows.delete(row.id)
      await audit.record({
        actor: 'user',
        kind: 'system.device_revoked',
        subject_type: 'system',
        subject_id: row.id,
        summary: `Revoked the device "${row.name}"`,
        detail: { name: row.name },
      })
      return ok(c, { removed: true })
    })
    .get('/android', async (c) => ok(c, await androidAppSettings()))
    .put('/android', validJson(androidAppInput), async (c) => {
      const { override, replace_official } = c.req.valid('json')
      if (override === null) {
        await androidAppRows.clear()
      } else {
        await androidAppRows.set(
          { package_name: override.package_name, cert_sha256: JSON.stringify(override.cert_sha256), replace_official },
          new Date().toISOString(),
        )
      }
      const verb = replace_official ? 'in place of' : 'next to'
      await audit.record({
        actor: 'user',
        kind: 'system.android_app_changed',
        subject_type: 'system',
        summary:
          override === null
            ? 'Removed the self-built Android app'
            : `Set the self-built Android app ${override.package_name} ${verb} the official app`,
        detail: {
          package_name: override?.package_name ?? null,
          cert_sha256: override?.cert_sha256 ?? [],
          replace_official,
        },
      })
      return ok(c, await androidAppSettings())
    })
}
