import { Hono } from 'hono'
import { currentRequestSource } from '../access.js'
import { ok } from '../http.js'
import { widgetSummary } from '../widget.js'

/** A paired phone shows agent titles unless the user hid them for it; a browser always does. */
const showNames = () => {
  const source = currentRequestSource()
  return source?.via === 'device' ? source.showNames : true
}

/** The read-only summary a paired phone's home screen widget shows; browsers may read it too. */
export const widgetRoutes = new Hono().get('/summary', async (c) =>
  ok(c, await widgetSummary({ showNames: showNames() })),
)
