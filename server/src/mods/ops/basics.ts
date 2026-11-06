import { MOD_LIMITS, modAuditKind, modNotifyUrl, modScoped } from '@seti/shared'
import { z } from 'zod'
import { audit } from '../../audit.js'
import { HttpError } from '../../http.js'
import { pushToEveryDevice } from '../../notifications.js'
import { modAuditKinds, notifyKinds } from '../points.js'
import { kindEnabled, settingsWithDefaults } from '../values.js'
import { defineOp } from './define.js'
import { takeSend } from './limits.js'

const localName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/)

const detailValue = z.union([
  z.string().max(1000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(200)).max(20),
])

/** A status bar item mod logic set, shown until the mod sets it again or turns off. */
export interface ModStatusItem {
  mod: string
  item: string
  text: string
  icon: string | null
  at: number
}

/** Status bar items mod logic set, by `<mod>.<item>`. */
export const modStatusItems = new Map<string, ModStatusItem>()

const STATUS_EVERY_MS = 1000

/** What every mod may do on its own: read its settings, audit its kinds, set its status items. */
export const basicOps = {
  'settings.get': defineOp({
    args: z.strictObject({}),
    run: async (_args, { call, manifest }) => settingsWithDefaults(manifest, call.modId),
  }),
  'audit.record': defineOp({
    args: z.strictObject({
      kind: localName,
      summary: z.string().trim().min(1).max(300),
      detail: z.record(z.string().max(64), detailValue).optional(),
    }),
    run: async (args, { call }) => {
      const kind = modAuditKind(call.modId, args.kind)
      if (modAuditKinds.get(kind)?.mod !== call.modId) {
        throw new HttpError(403, `${args.kind} is not an audit kind the mod ${call.modId} declared`)
      }
      const detail = args.detail ?? {}
      if (Buffer.byteLength(JSON.stringify(detail)) > MOD_LIMITS.auditDetailBytes) {
        throw new HttpError(413, `An audit detail is at most ${String(MOD_LIMITS.auditDetailBytes / 1024)} KB`)
      }
      await audit.record({
        actor: 'user',
        kind,
        subject_type: 'mod',
        subject_id: call.modId,
        summary: args.summary,
        detail,
      })
      return null
    },
  }),
  'status.set': defineOp({
    args: z.strictObject({
      item: localName,
      text: z.string().max(MOD_LIMITS.statusChars),
      icon: localName.optional(),
    }),
    run: async (args, { call, manifest }) => {
      if (!manifest.contributes.statusBar.some((entry) => entry.id === args.item)) {
        throw new HttpError(403, `${args.item} is not a status bar item the mod ${call.modId} declared`)
      }
      const key = modScoped(call.modId, args.item)
      const at = Date.now()
      if (at - (modStatusItems.get(key)?.at ?? 0) < STATUS_EVERY_MS) {
        throw new HttpError(429, `${args.item} changes at most once a second`)
      }
      modStatusItems.set(key, { mod: call.modId, item: args.item, text: args.text, icon: args.icon ?? null, at })
      return Promise.resolve(null)
    },
  }),
  'notify.send': defineOp({
    args: z.strictObject({
      kind: localName,
      title: z.string().trim().min(1).max(MOD_LIMITS.notifyTitleChars),
      body: z.string().max(MOD_LIMITS.notifyBodyChars).default(''),
      url: z.string().max(2000).optional(),
    }),
    run: async (args, { call, manifest }) => {
      const kind = modScoped(call.modId, args.kind)
      if (notifyKinds.get(kind)?.mod !== call.modId) {
        throw new HttpError(403, `${args.kind} is not a notification kind of the mod ${call.modId}`)
      }
      if (!(await kindEnabled(manifest, args.kind))) {
        return { sent: 0 }
      }
      takeSend(call, 'notify')
      const sent = await pushToEveryDevice({
        title: args.title,
        body: args.body,
        tag: kind,
        kind,
        url: modNotifyUrl(args.url),
      })
      return { sent }
    },
  }),
}
