import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import { serverEnv } from './env.js'

const SERVER_DIR = path.join(import.meta.dirname, '../../../server')

/** Runs `pnpm setup-code` against this worker's Seti, as the user would on the host. */
export function setupCode(): string {
  const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/setup-code-cli.ts'], {
    cwd: SERVER_DIR,
    env: serverEnv(),
    encoding: 'utf8',
  })
  const code = /Setup code: (\S+)/.exec(out)?.[1]
  if (code === undefined) {
    throw new Error(`setup-code printed no code:\n${out}`)
  }
  return code
}

/** A platform authenticator with user verification, through Chromium's WebAuthn domain. */
export async function virtualAuthenticator(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
}

/** Passkeys need a host name, so the browser calls the worker's Seti as localhost. */
export const onLocalhost = (baseURL: string) => baseURL.replace('//127.0.0.1:', '//localhost:')
