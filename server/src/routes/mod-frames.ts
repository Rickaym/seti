import {
  MOD_FRAME_HASH_CHARS,
  modFrameCallInput,
  modFrameParams,
  modFrameQuery,
  modFrameReportInput,
  modParams,
  type ModFrameInfo,
  type ModFrameKind,
  type ModFrameReportInput,
  type ModManifest,
} from '@seti/shared'
import { Hono } from 'hono'
import { currentRequestSource } from '../access.js'
import { now } from '../db.js'
import { HttpError, ok, valid, validJson } from '../http.js'
import { modHost } from '../mods/bundled.js'
import { checkViewCall } from '../mods/frames/calls.js'
import { frameBody, frameHeaders } from '../mods/frames/policy.js'
import { runViewCall } from '../mods/frames/runtime.js'
import { modFramePages, type ModFramePages } from '../mods/frames/source.js'
import { modLogs } from '../store/mod-logic.js'

/** Only the user's own open page shows a mod's views; nobody acting for the user reaches them. */
function refuseDelegates(): void {
  const via = currentRequestSource()?.via
  if (via === 'ea' || via === 'agent' || via === 'mod' || via === 'device') {
    throw new HttpError(403, "Only the user's own page opens a mod's views")
  }
}

interface Framed {
  manifest: ModManifest
  pages: ModFramePages
}

/** A third-party mod that runs now with its pages; any other answers as if it did not exist. */
function framed(id: string): Framed {
  refuseDelegates()
  const mod = modHost.get(id)
  const manifest = mod?.manifest ?? null
  const pages = modFramePages.get(id)
  if (mod?.tier !== 'third-party' || manifest === null || mod.disposers === null || pages === undefined) {
    throw new HttpError(404, 'Not found')
  }
  if (modHost.heldBySafeMode(mod)) {
    throw new HttpError(404, 'Not found')
  }
  return { manifest, pages }
}

const shortHash = (pages: ModFramePages) => pages.hash.slice(0, MOD_FRAME_HASH_CHARS)

function entryOf(manifest: ModManifest, kind: ModFrameKind, name: string): string | undefined {
  const pages = kind === 'views' ? manifest.contributes.views : manifest.contributes.fileViewers
  return pages.find((page) => page.id === name)?.entry
}

const REPORTS: Record<ModFrameReportInput['reason'], string> = {
  navigated: 'tried to leave its page, so Seti stopped it',
  flooded: 'sent too many messages, so Seti stopped it',
  oversized: 'sent messages over 64 KB, so Seti stopped it',
  malformed: 'sent a message the bridge does not take, which Seti dropped',
}

/** A mod's sandboxed pages, and the bridge calls the page relays for them. */
export const modFrameRoutes = new Hono()
  .get('/:id', valid('param', modParams), (c) =>
    ok(c, { hash: shortHash(framed(c.req.valid('param').id).pages) } satisfies ModFrameInfo),
  )
  .get('/:id/:kind/:name', valid('param', modFrameParams), valid('query', modFrameQuery), (c) => {
    const { id, kind, name } = c.req.valid('param')
    const { manifest, pages } = framed(id)
    const entry = entryOf(manifest, kind, name)
    const page = entry === undefined || c.req.valid('query').v !== shortHash(pages) ? null : pages.page(entry)
    if (page === null) {
      throw new HttpError(404, 'Not found')
    }
    const headers = frameHeaders(c.req.header('sec-fetch-dest'), page.scriptHashes)
    return c.body(frameBody(page.html), 200, headers)
  })
  .post('/:id/call', valid('param', modParams), validJson(modFrameCallInput), async (c) => {
    const { manifest } = framed(c.req.valid('param').id)
    const call = checkViewCall(manifest, c.req.valid('json'))
    return ok(c, await runViewCall(call, manifest))
  })
  .post('/:id/report', valid('param', modParams), validJson(modFrameReportInput), async (c) => {
    const { manifest } = framed(c.req.valid('param').id)
    const { view, reason } = c.req.valid('json')
    const title = [...manifest.contributes.views, ...manifest.contributes.fileViewers].find((page) => page.id === view)
    if (title === undefined) {
      throw new HttpError(404, `${manifest.name} has no view ${view}`)
    }
    const level = reason === 'malformed' ? 'info' : 'warn'
    const line = `Its ${title.title} view ${REPORTS[reason]}`
    await modLogs.append(manifest.id, null, now(), [{ kind: 'system', level, line }])
    return ok(c, null)
  })
