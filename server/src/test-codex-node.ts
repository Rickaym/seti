import fs from 'node:fs'
import { routeEgressForTests } from './task-proxy.js'
import { modelUpstream } from './test-codex-upstream.js'

// A split node for the Codex proof only: its proxies reach the test's model host, then it runs.
const [port = '', caFile = '', notes = ''] = process.argv.slice(2)
routeEgressForTests(
  modelUpstream(Number(port), fs.readFileSync(caFile, 'utf8'), (kind, host) => {
    fs.appendFileSync(notes, `${kind} ${host}\n`)
  }),
)
await import('./node/main.js')
