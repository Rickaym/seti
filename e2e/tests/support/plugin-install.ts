import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { paths } from './env.js'
import { expect } from './fixtures.js'

const dir = path.join(paths.root, 'fake-claude-cli')
const stateFile = path.join(dir, 'state.json')
const callsFile = path.join(dir, 'calls.log')

export const MARKET = { source: 'acme/e2e-plugins', name: 'e2e-market' } as const

/** The marketplace the fake can add, with two plugins; nothing is added or installed yet. */
export function resetFakeClaudeCli(): void {
  fs.mkdirSync(dir, { recursive: true })
  const plugins = [
    { name: 'greeter', description: 'Greets the team every morning', version: '1.2.0', skills: ['hello'] },
    { name: 'linter', description: 'Lints shell scripts', version: '0.3.0', skills: ['shellcheck'] },
  ]
  const market = { name: MARKET.name, repo: MARKET.source, plugins }
  fs.writeFileSync(stateFile, JSON.stringify({ sources: { [MARKET.source]: market }, marketplaces: [], installed: [] }))
  fs.rmSync(callsFile, { force: true })
}

/** Puts a fake `claude` on SETI_CLAUDE_BIN that answers plugin commands from a state file. */
export function fakeClaudeCliEnv(): NodeJS.ProcessEnv {
  resetFakeClaudeCli()
  const cli = path.join(import.meta.dirname, 'fake-claude-cli.ts')
  const bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 })
  return { SETI_CLAUDE_BIN: bin, SETI_E2E_CLAUDE_STATE: stateFile }
}

/** The arguments of every change the fake ran, in order. */
export function fakeChanges(): string[][] {
  const lines = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\n') : []
  return lines
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => !args.includes('list') && !args.includes('details'))
}

/** Adds the fake marketplace through Settings, Plugins, and waits for its row. */
export async function addMarketplace(page: Page): Promise<void> {
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Add marketplace' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add marketplace' })
  await dialog.getByLabel('Marketplace source').fill(MARKET.source)
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toBeHidden()
  const row = main.getByRole('listitem', { name: `${MARKET.name} marketplace` })
  await expect(row).toContainText(MARKET.source)
  await expect(row).toContainText('2 plugins')
}

/** Searches the catalog for greeter, checks what it brings and installs it. */
export async function installGreeter(page: Page): Promise<void> {
  await page.getByRole('main').getByRole('button', { name: 'Add plugin' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add plugin' })
  await dialog.getByLabel('Search marketplace plugins').fill('greets')
  const results = dialog.getByRole('list', { name: 'Marketplace plugins' })
  await expect(results.getByRole('button')).toHaveCount(1)
  await results.getByRole('button', { name: `greeter from ${MARKET.name}` }).click()
  await expect(dialog).toContainText('1 skill')
  await expect(dialog).toContainText('hello')
  await expect(dialog).toContainText('Plugins run third-party code on this machine')
  await dialog.getByRole('button', { name: 'Install' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('Running agents pick this up in their next session.')).toBeVisible()
  await expect(page.getByRole('main').getByRole('button', { name: 'greeter plugin' })).toContainText(MARKET.name)
}

/** Uninstalls greeter after confirming, and waits for its row to go. */
export async function uninstallGreeter(page: Page): Promise<void> {
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Uninstall greeter' }).click()
  const confirm = page.getByRole('dialog', { name: 'Uninstall plugin' })
  await expect(confirm).toContainText(`greeter@${MARKET.name}`)
  await confirm.getByRole('button', { name: 'Uninstall' }).click()
  await expect(confirm).toBeHidden()
  await expect(page.getByText('Uninstalled greeter')).toBeVisible()
  await expect(main.getByRole('button', { name: 'greeter plugin' })).toHaveCount(0)
}
