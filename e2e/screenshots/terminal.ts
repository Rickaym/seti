import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { WorkspaceEntry } from '@seti/shared'
import { NOW } from './clock.js'
import { AGENTS } from './seed.js'
import { paths } from '../tests/support/env.js'
import { apiData, expect } from '../tests/support/fixtures.js'
import { run, screenOf, terminalIn, tileIn } from '../tests/support/terminal.js'

const REPO = path.join(paths.home, 'storefront')
const BRANCH = 'fix/checkout-capture-retry'

/** A neutral prompt and git setup in the storefront checkout, then a clean screen. */
const SETUP = [
  `PS1='\\[\\e[1;34m\\]~/storefront\\[\\e[0m\\]$ '`,
  'export GIT_CONFIG_GLOBAL=/dev/null GIT_PAGER=cat',
  'cd storefront',
  'clear',
].join('; ')

/** The storefront's history: main, and the checkout agent's branch on top of it. */
const COMMITS: [branch: string, file: string, subject: string][] = [
  ['main', 'src/cart/currency.ts', 'feat(cart): shopper currency'],
  ['main', 'package.json', 'chore(deps): payments SDK 4.2'],
  ['main', 'src/checkout/saved-cards.ts', 'feat(checkout): saved cards'],
  ['main', 'src/checkout/3ds.test.ts', 'test: 3-D Secure redirects'],
  [BRANCH, 'src/checkout/capture.ts', 'fix(checkout): retry on timeout'],
  [BRANCH, 'src/checkout/capture.test.ts', 'test: timeouts'],
  ['main', 'src/cart/badge.tsx', 'fix(cart): badge waits for currency'],
]

function git(args: string[], minutesAgo = 0): void {
  const date = new Date(NOW - minutesAgo * 60_000).toISOString()
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- uses the git on the runner PATH
  execFileSync('git', ['-c', 'user.name=Acme Dev', '-c', 'user.email=dev@acme.example', ...args], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH,
      HOME: paths.home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  })
}

/** A fictional storefront repo in the home folder that new shells start in. */
export function seedTerminalHome(): void {
  fs.mkdirSync(REPO, { recursive: true })
  git(['init', '-q', '-b', 'main'])
  const branches = new Set(['main'])
  let current = 'main'
  COMMITS.forEach(([branch, file, subject], i) => {
    if (branch !== current) {
      git(['checkout', '-q', ...(branches.has(branch) ? [] : ['-b']), branch])
      branches.add(branch)
      current = branch
    }
    fs.mkdirSync(path.dirname(path.join(REPO, file)), { recursive: true })
    fs.writeFileSync(path.join(REPO, file), `// ${subject}\n`)
    git(['add', file])
    git(['commit', '-q', '-m', subject], (COMMITS.length - i) * 90)
  })
  git(['checkout', '-q', BRANCH])
  fs.appendFileSync(path.join(REPO, 'src/checkout/capture.ts'), 'export const ATTEMPTS = 3\n')
}

/** The workspace grid as `panels`, replacing whatever an earlier frame left in it. */
async function putGrid(page: Page, panels: object[]): Promise<void> {
  const [workspace] = await apiData<WorkspaceEntry[]>(page.request, '/workspaces')
  const response = await page.request.put(`/api/mods/grid/layouts/${workspace?.id ?? ''}`, {
    data: { layout: { panels, locked: false, perScreen: null } },
  })
  expect(response.ok(), 'PUT the grid layout').toBe(true)
}

async function enterRepo(scope: Locator): Promise<void> {
  await run(scope, SETUP)
  await expect(screenOf(scope)).toHaveText(/^~\/storefront\$\s*$/u)
}

const panel = (i: string, agent: string, x: number, y: number) => ({ i, agent, x, y, w: 6, h: 12 })

/** Three agents in the grid with a shell beside them, its log showing the agent's branch. */
export async function gridTerminal(page: Page): Promise<void> {
  const terminal = { id: randomUUID(), name: 'storefront', task: null }
  await putGrid(page, [
    panel('a', AGENTS.checkout, 0, 0),
    { ...panel('b', '', 6, 0), agent: null, terminal },
    panel('c', AGENTS.infra, 0, 12),
    panel('d', AGENTS.cart, 6, 12),
  ])
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Grid', exact: true }).click()
  await expect(page.locator('[data-grid-item]')).toHaveCount(4)
  const tile = tileIn(page, 'storefront')
  await enterRepo(tile)
  await run(tile, 'git log --oneline --graph --all')
  await expect(screenOf(tile)).toContainText('saved cards')
  await run(tile, 'git diff --stat main...')
  await expect(screenOf(tile)).toContainText('2 files changed')
  await expect(page.getByText('Allow Bash?')).toBeVisible()
}

/** A shell on a phone, with the key row above the input line. */
export async function phoneTerminal(page: Page): Promise<void> {
  await putGrid(page, [])
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal' }).tap()
  const terminal = terminalIn(page)
  await enterRepo(terminal)
  await run(terminal, 'git status -sb')
  await expect(screenOf(terminal)).toContainText(`## ${BRANCH}`)
  await run(terminal, "git log --format='%h %s' -6")
  await expect(screenOf(terminal)).toContainText('saved cards')
  await expect(terminal.getByRole('toolbar', { name: 'Terminal keys' })).toBeVisible()
}
