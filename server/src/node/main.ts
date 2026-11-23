import { NODE_SOCKET, SDK_MODULE } from '../config.js'
import '../node-commands.js'
import { controlLink, reachControl } from '../node-link.js'
import { loadSdkModule } from '../runtimes/registry.js'
import { changedEntry, liveSessions } from '../session-host.js'
import { NodeService } from './service.js'
import { listenNode } from './socket.js'

/** How long a stopping node gives each step: the record, the cut turns, the last entries. */
const STOP_GRACE_MS = 7000

const running = () => liveSessions().filter(([, session]) => session.running && !session.closed)

const service = new NodeService(
  {
    command: async (type, body) => controlLink.run(type, body),
    snapshot: () =>
      liveSessions().map(([agent, session]) => ({ agent, state: changedEntry(session), since: session.since })),
    cut: async (graceMs) => {
      await controlLink.run('sessions.cut', { agents: running().map(([agent]) => agent), graceMs })
    },
  },
  process.env.SETI_BUILD_ID ?? 'dev',
)
reachControl(service.control)
if (SDK_MODULE !== '') {
  await loadSdkModule(SDK_MODULE)
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void service.stop(STOP_GRACE_MS).finally(() => process.kill(process.pid, signal))
  })
}

await listenNode(NODE_SOCKET, (socket) => {
  service.attach(socket)
})
process.stdout.write(`seti node listening on ${NODE_SOCKET}\n`)
