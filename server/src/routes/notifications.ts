import {
  notificationFocusInput,
  notificationSettingsInput,
  pushDeviceInput,
  pushDeviceParams,
  testNotificationInput,
} from '@seti/shared'
import { Hono } from 'hono'
import { ok, valid, validJson } from '../http.js'
import {
  changeNotificationSettings,
  notificationStatus,
  removePushDevice,
  savePushDevice,
  sendTestNotification,
} from '../notifications.js'
import { recordFocus } from '../presence.js'

export const notificationRoutes = new Hono()
  .get('/', async (c) => ok(c, await notificationStatus()))
  .put('/settings', validJson(notificationSettingsInput), async (c) => {
    const input = c.req.valid('json')
    const change = Object.fromEntries(Object.entries(input).filter(([, on]) => on !== undefined))
    return ok(c, await changeNotificationSettings(change))
  })
  .put('/devices/:device_id', valid('param', pushDeviceParams), validJson(pushDeviceInput), async (c) =>
    ok(c, await savePushDevice(c.req.valid('param').device_id, c.req.valid('json'))),
  )
  .delete('/devices/:device_id', valid('param', pushDeviceParams), async (c) => {
    await removePushDevice(c.req.valid('param').device_id)
    return c.body(null, 204)
  })
  .put('/focus', validJson(notificationFocusInput), (c) => {
    recordFocus(c.req.valid('json'))
    return c.body(null, 204)
  })
  .post('/test', validJson(testNotificationInput), async (c) =>
    ok(c, await sendTestNotification(c.req.valid('json').device_id)),
  )
