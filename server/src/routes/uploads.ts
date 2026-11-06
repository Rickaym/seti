import fs from 'node:fs'
import { Readable } from 'node:stream'
import { uploadParams, uploadQuery, type StagedUpload } from '@seti/shared'
import { Hono } from 'hono'
import { HttpError, ok, valid } from '../http.js'
import { removeStaged, stagedPath, stagedUpload, stageUpload } from '../uploads.js'

/** Only what the composer shows in place: thumbnails, and text to put back into the message. */
const IMAGES = /^image\/(png|jpeg|gif|webp)$/

function servedAs(staged: StagedUpload): { type: string; disposition: string } {
  if (staged.kind === 'text') {
    return { type: 'text/plain; charset=utf-8', disposition: 'inline' }
  }
  return IMAGES.test(staged.mime)
    ? { type: staged.mime, disposition: 'inline' }
    : { type: 'application/octet-stream', disposition: 'attachment' }
}

/** Files for a message not sent yet: the body is the file, streamed to disk under a size cap. */
export const uploadRoutes = new Hono()
  .post('/', valid('query', uploadQuery), async (c) => ok(c, await stageUpload(c.req.raw.body, c.req.valid('query'))))
  .get('/:id', valid('param', uploadParams), (c) => {
    const { id } = c.req.valid('param')
    const staged = stagedUpload(id)
    if (staged === null) {
      throw new HttpError(404, 'Upload not found')
    }
    const { type, disposition } = servedAs(staged)
    const stream = fs.createReadStream(stagedPath(id))
    return c.body(Readable.toWeb(stream) as ReadableStream<Uint8Array>, 200, {
      'Content-Type': type,
      'Content-Length': String(staged.size),
      'Content-Disposition': disposition,
      'Cache-Control': 'private, max-age=86400, immutable',
    })
  })
  .delete('/:id', valid('param', uploadParams), (c) => {
    removeStaged(c.req.valid('param').id)
    return c.body(null, 204)
  })
