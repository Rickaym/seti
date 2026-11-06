import { parseArgs } from 'node:util'

const USAGE = `Usage:
  secrets unseal-channels
      Writes webhook secrets back in the clear, for rolling Seti back to a version before the
      secret store. Needs the secret-key credential, so run it under systemd-run; see
      docs/security.md.
`

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true })
  const [command] = positionals
  if (command !== 'unseal-channels') {
    process.stdout.write(USAGE)
    process.exitCode = command === undefined ? 0 : 1
    return
  }
  const { closeDatabase, openDatabase } = await import('./db.js')
  const { channelStore } = await import('./store/channels.js')
  try {
    await openDatabase()
    const count = await channelStore.unsealSecrets()
    process.stdout.write(`Wrote ${String(count)} webhook secrets back in the clear.\n`)
  } finally {
    await closeDatabase()
  }
}

await main()
