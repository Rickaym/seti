import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { isLoopback, optionalKeys, report, type Check } from './doctor.js'

const USAGE = `Usage: pnpm doctor [--env-file <file>]

Checks what Seti needs on this machine and prints a fix for each problem. It reads the settings
in SETI_HOME/seti.env (~/.seti/seti.env by default) like the service does, and never prints a
secret. Exits with 1 when something Seti needs is missing.
`

const EA_KEYS = ['openai-api-key', 'deepgram-api-key', 'elevenlabs-api-key']
const TURN_KEYS = ['cloudflare-turn-key-id', 'cloudflare-turn-api-token']

/** Loads the env file the service loads; variables already set in the shell win. */
function loadSettings(file: string | undefined): string | null {
  const home = process.env.SETI_HOME ?? path.join(os.homedir(), '.seti')
  const envFile = file ?? path.join(home, 'seti.env')
  if (!fs.existsSync(envFile)) {
    return null
  }
  process.loadEnvFile(envFile)
  return envFile
}

async function exposureChecks(): Promise<Check[]> {
  const { CREDENTIALS, EA_URL, HOST, PORT, PUBLIC_ACCESS } = await import('./config.js')
  const s = 'Network'
  const checks: Check[] = []
  if (!isLoopback(HOST)) {
    const label = `listens on ${HOST}, so other machines reach the API (the local token still applies)`
    checks.push({ section: s, state: 'warn', label, fix: 'SETI_HOST=127.0.0.1 and a reverse proxy (docs/setup.md)' })
  }
  if (PUBLIC_ACCESS !== null) {
    const gate = PUBLIC_ACCESS.cloudflare === null ? 'passkey sign-in alone guards' : 'Cloudflare Access guards'
    checks.push({ section: s, state: 'ok', label: `${gate} ${PUBLIC_ACCESS.origin}` })
  }
  const token = path.join(CREDENTIALS.dir, 'local-token-user')
  const label = `open http://seti.localhost:${String(PORT)} and sign in with the token in ${token}`
  checks.push({ section: s, state: 'info', label })
  const { portChecks } = await import('./doctor-checks.js')
  return [...checks, ...(await portChecks(HOST, EA_URL))]
}

async function eaChecks(): Promise<Check[]> {
  const { CREDENTIALS } = await import('./config.js')
  const s = 'Executive Assistant (optional)'
  const keys = optionalKeys(CREDENTIALS.dir, [...EA_KEYS, ...TURN_KEYS])
  if (!keys.set.includes('openai-api-key')) {
    const fix = `write the key to ${path.join(CREDENTIALS.dir, 'openai-api-key')}`
    return [{ section: s, state: 'info', label: 'no OpenAI key: the EA chat and voice stay off', fix }]
  }
  const voice = EA_KEYS.every((key) => keys.set.includes(key))
  const checks: Check[] = [
    { section: s, state: 'ok', label: 'OpenAI key set: the EA chat works' },
    voice
      ? { section: s, state: 'ok', label: 'Deepgram and ElevenLabs keys set: voice calls work' }
      : { section: s, state: 'info', label: 'voice calls need deepgram-api-key and elevenlabs-api-key' },
  ]
  if (TURN_KEYS.every((key) => keys.set.includes(key))) {
    checks.push({ section: s, state: 'ok', label: 'Cloudflare TURN keys set: calls work from other networks' })
  }
  return checks
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help === true) {
    process.stdout.write(USAGE)
    return
  }
  const envFile = loadSettings(values['env-file'])
  process.stdout.write(`Seti doctor, settings from ${envFile ?? 'the environment only'}\n\n`)
  const checks = await import('./doctor-checks.js').catch((e: unknown) => {
    const label = `Seti cannot read its settings: ${e instanceof Error ? e.message : String(e)}`
    const fix = `edit ${envFile ?? 'the environment'}; docs/setup.md lists every variable`
    process.stdout.write(report([{ section: 'Configuration', state: 'fail', label, fix }]))
    return null
  })
  if (checks === null) {
    process.exitCode = 1
    return
  }
  const database = await checks.databaseChecks()
  const found = [
    ...(await checks.runtimeChecks()),
    ...checks.credentialsChecks(),
    ...database.checks,
    ...(await checks.redisChecks()),
    ...(await checks.sandboxChecks()),
    ...(await checks.claudeChecks(database.claudeToken)),
    ...(await checks.githubChecks()),
    ...(await exposureChecks()),
    ...(await checks.serviceChecks()),
    ...(await eaChecks()),
  ]
  process.stdout.write(report(found))
  process.exitCode = found.some((check) => check.state === 'fail') ? 1 : 0
}

await main()
