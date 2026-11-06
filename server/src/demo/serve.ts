import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { setiSubdomainOf } from '@seti/shared'
import { Hono, type MiddlewareHandler } from 'hono'
import { createApp } from '../app.js'
import { DATABASE_URL, HOST, PORT, PUBLIC_ACCESS } from '../config.js'
import { openDatabase } from '../db.js'
import { fail } from '../http.js'
import { modHost } from '../mods/bundled.js'
import { demoModRoute } from '../mods/points.js'
import { loadPlannerModule } from '../planner.js'
import { runTurn } from '../runner.js'
import { loadSdkModule } from '../sdk-query.js'
import { DEMO_ALLOWLIST } from './allowlist.js'
import { demoCapabilityRoutes } from './capabilities.js'
import { AGENTS } from './content/cast.js'
import { startDemoEa } from './ea.js'
import { demoGuard } from './guard.js'
import { demoLoginRoutes, demoShell } from './login.js'
import { seedDemo } from './seed.js'
import { dropDemoDatabase } from '../store/demo.js'

/** Seti subdomains, such as PR previews, proxy to the web; the demo answers them with nothing. */
const noSubdomains: MiddlewareHandler = async (c, next) => {
  const hostname = (c.req.header('host') ?? '').replace(/:\d+$/, '').toLowerCase()
  if (setiSubdomainOf(hostname) !== null) {
    return fail(c, 404, 'Not found')
  }
  await next()
  return undefined
}

/** Seti's app behind the demo's guard, with the demo's sign-in and its marked page shell. */
export function demoApp(inner: Hono, resetsAt: Date): Hono {
  const app = new Hono()
  app.use('*', demoGuard(DEMO_ALLOWLIST, demoModRoute))
  app.use('*', noSubdomains)
  app.use('*', demoShell(resetsAt))
  app.route('/', demoCapabilityRoutes(PUBLIC_ACCESS))
  app.route('/', inner)
  app.route('/', demoLoginRoutes())
  return app
}

/** A demo module beside this one: TypeScript from source, JavaScript from the built bundle. */
const moduleFile = (name: string) =>
  fileURLToPath(new URL(`./${name}${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url))

/** Turns the busy seeded agents play at start; the infra one stops at a permission prompt. */
const OPENING_TURNS: [string, string][] = [
  [AGENTS.infra, 'The plan looks right. Apply it once I allow it.'],
  [AGENTS.orders, 'Carry on with the OpenAPI parameters.'],
  [AGENTS.checkout, 'Go on with the test for the third attempt.'],
]

/** Hours between resets; the process exits then, and its supervisor starts a fresh demo. */
function resetHours(): number {
  const hours = Number(process.env.SETI_DEMO_RESET_HOURS ?? '3')
  return Number.isFinite(hours) && hours > 0 ? hours : 3
}

/** Seeds a fresh demo, then serves it until the next reset. */
export async function serveDemo(root: string): Promise<void> {
  const resetsAt = new Date(Date.now() + resetHours() * 3_600_000)
  await dropDemoDatabase(DATABASE_URL)
  await openDatabase()
  await modHost.start()
  await loadSdkModule(moduleFile('agent'))
  await loadPlannerModule(moduleFile('planner'))
  const inner = createApp({ access: PUBLIC_ACCESS, verify: null }, await startDemoEa())
  await seedDemo(inner, root)
  const app = demoApp(inner, resetsAt)
  serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
    process.stdout.write(`seti demo listening on http://${info.address}:${String(info.port)}\n`)
    for (const [agent, prompt] of OPENING_TURNS) {
      void runTurn(agent, prompt)
    }
  })
  setTimeout(() => {
    process.stdout.write('seti demo: reset time; exiting so a fresh demo starts\n')
    process.exit(0)
  }, resetsAt.getTime() - Date.now())
}
