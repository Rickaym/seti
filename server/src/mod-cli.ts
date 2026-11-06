import path from 'node:path'
import { consentLines, consentWarnings, modAdds, shortModHash } from '@seti/shared'

const USAGE = 'Usage: pnpm mod check <folder> | pnpm mod dev <folder>'

/** Validates a package folder as Seti will, and prints its hash, size and consent copy. */
async function check(folder: string): Promise<void> {
  const { folderSource } = await import('./mods/package/read-folder.js')
  const { readPackage } = await import('./mods/package/validate.js')
  const { modHost } = await import('./mods/bundled.js')
  const pkg = await readPackage(folderSource(folder).read, modHost.bundledIds)
  const { manifest } = pkg
  const lines = [
    `${manifest.name} ${manifest.version} (${manifest.id})`,
    `${shortModHash(pkg.hash)}, ${String(Math.ceil(pkg.size / 1024))} KB, ${String(pkg.files.size)} files`,
    'It can:',
    ...consentLines(manifest, () => null).map((line) => `  ${line.text}`),
    ...(manifest.capabilities.length === 0 ? ['  It can only show its settings and its own views.'] : []),
    ...modAdds(manifest.contributes).map((add, i) => `${i === 0 ? 'It adds:\n' : ''}  ${add}`),
    ...consentWarnings(manifest, true).map((warning) => `Warning: ${warning}`),
    'Seti never runs install scripts or reads node_modules; only the files the manifest names ship.',
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

/** Hands a folder to the local Seti as a dev mod, with the local token only this host holds. */
async function dev(folder: string): Promise<void> {
  const { HOST, PORT } = await import('./config.js')
  const { credential } = await import('./credentials.js')
  const token = credential('local-token-user')
  if (token === null) {
    throw new Error('Seti has no local token on this host; start Seti first')
  }
  const res = await fetch(`http://${HOST}:${String(PORT)}/api/mod-admin/dev`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path: folder }),
  })
  const body = (await res.json()) as { data?: { message: string }; error?: { detail: string } }
  if (!res.ok) {
    throw new Error(body.error?.detail ?? `Seti answered ${String(res.status)}`)
  }
  process.stdout.write(`${body.data?.message ?? 'Done'}\n`)
}

async function main(): Promise<void> {
  const [command, folder] = process.argv.slice(2)
  if (folder === undefined || (command !== 'check' && command !== 'dev')) {
    throw new Error(USAGE)
  }
  const absolute = path.resolve(process.env.INIT_CWD ?? process.cwd(), folder)
  await (command === 'check' ? check(absolute) : dev(absolute))
}

try {
  await main()
  process.exit(0)
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
}
