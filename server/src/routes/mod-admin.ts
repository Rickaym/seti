import {
  modDevInput,
  modDevModeInput,
  modBisectAnswerInput,
  modHashInput,
  modInstallChangeInput,
  modInstallInput,
  modParams,
  modPreviewInput,
  modUninstallInput,
  modUpdateApplyInput,
} from '@seti/shared'
import { Hono } from 'hono'
import { audit } from '../audit.js'
import { ok, valid, validJson } from '../http.js'
import { listMods } from '../mods/actions.js'
import { answerBisect, endBisect, startBisect } from '../mods/bisect.js'
import { requireUserConsent } from '../mods/consent-guard.js'
import { loadDev, setDevMode, stopWatching, watchIfDev } from '../mods/dev.js'
import { installedVersion, installMod, previewInstall, rollbackMod, uninstallMod } from '../mods/install.js'
import { applyUpdate, checkForUpdate, skipUpdate } from '../mods/updates.js'
import { modLogs } from '../store/mod-logic.js'
import { modInstalls } from '../store/mod-packages.js'

const param = valid('param', modParams)

/** Install, consent, updates, rollback, uninstall, Developer mode and bisect: the user's alone. */
export const modAdminRoutes = new Hono()
  .post('/preview', validJson(modPreviewInput), async (c) => ok(c, await previewInstall(c.req.valid('json').source)))
  .post('/install', validJson(modInstallInput), async (c) => {
    const input = c.req.valid('json')
    await installMod(input)
    await watchIfDev(input.mod_id)
    return ok(c, await listMods())
  })
  .put('/dev-mode', validJson(modDevModeInput), async (c) => {
    await setDevMode(c.req.valid('json').on)
    return ok(c, await listMods())
  })
  .post('/dev', validJson(modDevInput), async (c) => ok(c, await loadDev(c.req.valid('json').path)))
  .post('/bisect', async (c) => ok(c, await startBisect()))
  .post('/bisect/answer', validJson(modBisectAnswerInput), async (c) =>
    ok(c, await answerBisect(c.req.valid('json').broken)),
  )
  .post('/bisect/keep', async (c) => {
    await endBisect(true)
    return ok(c, await listMods())
  })
  .delete('/bisect', async (c) => {
    await endBisect(false)
    return ok(c, await listMods())
  })
  .get('/mods/:id/log', param, async (c) => {
    await requireUserConsent({ stepUp: false })
    return ok(c, await modLogs.newest(c.req.valid('param').id, 200))
  })
  .patch('/mods/:id', param, validJson(modInstallChangeInput), async (c) => {
    await requireUserConsent({ stepUp: false })
    const { id } = c.req.valid('param')
    const change = c.req.valid('json')
    const { install } = await installedVersion(id)
    const delay = change.update_delay_hours ?? install.update_delay_hours
    const track = install.source_kind === 'git' ? (change.track ?? install.track) : null
    await modInstalls.change(id, delay, track)
    await audit.record({
      actor: 'user',
      kind: 'mod.settings_changed',
      subject_type: 'mod',
      subject_id: id,
      summary: `Changed how the ${id} mod updates`,
      detail: { mod: id, update_delay_hours: delay, track },
    })
    return ok(c, await listMods())
  })
  .post('/mods/:id/update/check', param, async (c) => ok(c, { message: await checkForUpdate(c.req.valid('param').id) }))
  .post('/mods/:id/update/apply', param, validJson(modUpdateApplyInput), async (c) => {
    await applyUpdate(c.req.valid('param').id, c.req.valid('json'))
    return ok(c, await listMods())
  })
  .post('/mods/:id/update/skip', param, validJson(modHashInput), async (c) => {
    await skipUpdate(c.req.valid('param').id, c.req.valid('json').hash)
    return ok(c, await listMods())
  })
  .post('/mods/:id/rollback', param, validJson(modHashInput), async (c) => {
    await rollbackMod(c.req.valid('param').id, c.req.valid('json').hash)
    return ok(c, await listMods())
  })
  .post('/mods/:id/uninstall', param, validJson(modUninstallInput), async (c) => {
    const { id } = c.req.valid('param')
    await uninstallMod(id, c.req.valid('json').delete_data)
    stopWatching(id)
    return ok(c, await listMods())
  })
