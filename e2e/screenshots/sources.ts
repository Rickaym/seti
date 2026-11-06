import http from 'node:http'
import type { AddressInfo } from 'node:net'

/** A fictional service a poller reads; `stage` 0 is what the first run records, 1 what changed. */
interface Service {
  /** The host the README shows in place of this server's loopback address. */
  host: string
  body: (stage: number) => string
}

const component = (id: string, name: string, status: string) => ({ id, name, status })

const PAYMENTS: Service = {
  host: 'status.paymentsco.example',
  body: (stage) =>
    JSON.stringify({
      components: [
        component('api', 'Payments API', 'operational'),
        component('auth', 'Card authorisation', stage === 0 ? 'operational' : 'degraded_performance'),
        component('payouts', 'Payouts', 'operational'),
        component('dashboard', 'Merchant dashboard', 'operational'),
      ],
    }),
}

const entry = (version: string, day: string) =>
  `<item><title>Node.js ${version} (LTS)</title><link>https://nodejs.example/blog/release/v${version}</link>` +
  `<guid>v${version}</guid><pubDate>${day}</pubDate><description>Security and bug fixes.</description></item>`

const NODE: Service = {
  host: 'nodejs.example',
  body: (stage) => {
    const latest = stage === 0 ? '' : entry('24.11.1', 'Tue, 27 Oct 2026 09:00:00 GMT')
    const older = `${entry('24.11.0', 'Tue, 13 Oct 2026 09:00:00 GMT')}${entry('22.21.0', 'Wed, 07 Oct 2026 09:00:00 GMT')}`
    return `<?xml version="1.0"?><rss version="2.0"><channel><title>Node.js releases</title>${latest}${older}</channel></rss>`
  },
}

const ticket = (id: number, subject: string, priority: string) => ({ id, subject, priority, status: 'open' })

const HELPDESK: Service = {
  host: 'api.helpdesk.example',
  body: (stage) =>
    JSON.stringify({
      tickets: [
        ticket(4113, 'Invoice PDF shows the wrong VAT number', 'normal'),
        ...(stage === 0 ? [ticket(4120, 'Cannot reset password from the app', 'high')] : []),
        ticket(4127, 'Card declined twice, charged once', 'urgent'),
        ...(stage === 0 ? [] : [ticket(4131, 'Checkout hangs on 3-D Secure in Safari', 'urgent')]),
      ],
    }),
}

const SERVICES = { payments: PAYMENTS, node: NODE, helpdesk: HELPDESK } as const

export type ServiceName = keyof typeof SERVICES

export interface Sources {
  /** The loopback origin a poller fetches for this service. */
  origin: (name: ServiceName) => string
  /** Each loopback origin and host:port, paired with what the README shows for it. */
  replacements: () => [from: string, to: string][]
  advance: () => void
  close: () => Promise<void>
}

/** One loopback server per fictional service, so each maps back to its own host in the pictures. */
export async function startSources(): Promise<Sources> {
  let stage = 0
  const servers = new Map<ServiceName, http.Server>()
  for (const [name, service] of Object.entries(SERVICES) as [ServiceName, Service][]) {
    const server = http.createServer((_req, res) => {
      const xml = service.body(stage).startsWith('<')
      res.writeHead(200, { 'content-type': xml ? 'application/rss+xml' : 'application/json' })
      res.end(service.body(stage))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.set(name, server)
  }
  const hostOf = (name: ServiceName) => `127.0.0.1:${String((servers.get(name)?.address() as AddressInfo).port)}`
  return {
    origin: (name) => `http://${hostOf(name)}`,
    replacements: () =>
      (Object.keys(SERVICES) as ServiceName[]).flatMap((name): [string, string][] => [
        [`http://${hostOf(name)}`, `https://${SERVICES[name].host}`],
        [hostOf(name), SERVICES[name].host],
      ]),
    advance: () => {
      stage += 1
    },
    close: async () => {
      for (const server of servers.values()) {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve()
          })
        })
      }
    },
  }
}
