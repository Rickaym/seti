import fs from 'node:fs'
import path from 'node:path'
import { SANDBOX_POLICY_DEFAULT } from '@seti/shared'
import type { Hono } from 'hono'
import { readLocalTokens } from '../local-auth.js'
import { addDemoPr, registerDemoRepo } from './github.js'
import { seedAgents, seedTeamChat, stampChannels, stampEaChat, type SeedPlan } from '../store/demo-seed.js'
import { demoSeedRun } from '../store/demo.js'
import { sandboxPolicy } from '../store/sandbox.js'
import { userSettings } from '../store/user.js'
import { GUIDE_MARKDOWN, REPOS, type DemoRepo } from './content/cast.js'
import { seedChannels, seedEaChat, type SeedApi } from './content/flows.js'

/** A few files per repo, so the Files panel has something to open. */
const REPO_FILES: Record<DemoRepo, Record<string, string>> = {
  'acme/storefront': {
    'README.md': '# Acme storefront\n\nThe web shop. Run `pnpm dev` and open http://localhost:5173.\n',
    'src/checkout/payment.ts':
      'export async function capture(order: Order): Promise<Receipt> {\n  const charge = await gateway.charge(order.total, order.card)\n  return receiptOf(order, charge)\n}\n',
    'src/cart/PriceBadge.tsx':
      'export function PriceBadge({ amount }: { amount: number }) {\n  return <span>{format(amount)}</span>\n}\n',
  },
  'acme/api': {
    'README.md': '# Acme API\n\nOrders, payments and partners. v2 pages every list endpoint.\n',
    'src/routes/orders.ts':
      "router.get('/v2/orders', async (req, res) => {\n  res.json(await orders.findMany({ cursor: req.query.cursor, take: 50 }))\n})\n",
  },
  'acme/infra': {
    'README.md': '# Acme infrastructure\n\nTerraform for staging and production.\n',
    'modules/postgres/main.tf':
      'resource "aws_db_instance" "main" {\n  engine         = "postgres"\n  engine_version = "17.2"\n}\n',
  },
  'acme/docs': {
    'README.md': '# Acme docs\n\nGuides for partners.\n',
    'docs/migration-v2.md': GUIDE_MARKDOWN,
  },
}

/** Writes each demo repo under the data folder and returns where each one lives. */
function writeRepos(root: string): (repo: DemoRepo) => string {
  const dirOf = (repo: DemoRepo) => path.join(root, 'repos', repo)
  for (const repo of REPOS) {
    for (const [file, text] of Object.entries(REPO_FILES[repo])) {
      fs.mkdirSync(path.dirname(path.join(dirOf(repo), file)), { recursive: true })
      fs.writeFileSync(path.join(dirOf(repo), file), text)
    }
    registerDemoRepo(repo, dirOf(repo))
  }
  return dirOf
}

/** The PRs the fake GitHub starts with; the storefront one belongs to the checkout agent. */
function seedPullRequests(now: number): void {
  const updated = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
  const green: [string, 'SUCCESS'][] = [
    ['lint', 'SUCCESS'],
    ['typecheck', 'SUCCESS'],
    ['unit', 'SUCCESS'],
    ['e2e (chromium)', 'SUCCESS'],
  ]
  addDemoPr({
    slug: 'acme/storefront',
    number: 482,
    title: 'fix(checkout): retry card captures on gateway timeouts',
    body: 'Retries captures up to three times on a gateway timeout and keeps 3-D Secure working.',
    branch: 'fix/checkout-capture-retry',
    updatedAt: updated(4),
    review: 'CHANGES_REQUESTED',
    checks: green,
    unresolvedThreads: 2,
    labels: ['checkout', 'bug'],
  })
  addDemoPr({
    slug: 'acme/api',
    number: 219,
    title: 'feat(orders): cursor pagination for GET /v2/orders',
    body: 'Pages the orders list 50 at a time; v1 keeps its shape.',
    branch: 'feat/orders-cursor',
    updatedAt: updated(30),
    review: 'APPROVED',
    checks: green,
    unresolvedThreads: 0,
    labels: ['api'],
  })
  addDemoPr({
    slug: 'acme/infra',
    number: 77,
    title: 'chore(staging): Postgres 17',
    body: 'Moves staging to Postgres 17 in place.',
    branch: 'chore/staging-pg17',
    updatedAt: updated(90),
    review: 'REVIEW_REQUIRED',
    checks: [
      ['plan', 'SUCCESS'],
      ['policy', 'FAILURE'],
    ],
    unresolvedThreads: 0,
    labels: [],
  })
}

/** Calls the unguarded app in-process with the demo's own tokens, which never leave the server. */
function inProcessApi(app: Hono): SeedApi {
  const tokens = readLocalTokens()
  const headers = (asEa: boolean) => ({
    host: 'localhost',
    'content-type': 'application/json',
    authorization: `Bearer ${(asEa ? tokens.ea : tokens.user) ?? ''}`,
  })
  return {
    call: async (method, route, body, asEa = false) => {
      const init = { method, headers: headers(asEa), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
      const response = await app.request(route, init)
      if (!response.ok) {
        throw new Error(`demo seed: ${method} ${route} answered ${String(response.status)}`)
      }
      return ((await response.json()) as { data: unknown }).data
    },
    deliver: async (route, body, signature) => {
      const deliveryHeaders = { host: 'localhost', 'content-type': 'application/json', 'x-seti-signature': signature }
      await app.request(route, { method: 'POST', headers: deliveryHeaders, body })
    },
  }
}

/** Seeds the Acme cast into the fresh database, its repos into `root`, PRs into the fake GitHub. */
export async function seedDemo(app: Hono, root: string): Promise<void> {
  const now = Date.now()
  const plan: SeedPlan = { run: demoSeedRun, now, repoDir: writeRepos(root) }
  await userSettings.set({ name: 'Sam' })
  const { allowed_domains, hidden_paths } = SANDBOX_POLICY_DEFAULT
  await sandboxPolicy.save({ enabled: false, allowed_domains, hidden_paths })
  await seedAgents(plan)
  await seedTeamChat(plan)
  seedPullRequests(now)
  const api = inProcessApi(app)
  await seedChannels(api)
  await stampChannels(plan)
  await seedEaChat(api)
  await stampEaChat(plan)
}
