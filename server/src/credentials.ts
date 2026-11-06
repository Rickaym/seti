import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CREDENTIALS, type CredentialSource } from './config.js'

/** Credentials the server reads, as named in LoadCredential= lines of deploy/seti.service. */
export type CredentialName = 'secret-key' | 'local-token-user' | 'local-token-ea' | 'openai-api-key'

/** Credentials a development run creates for itself when they are missing. */
const GENERATED: Partial<Record<CredentialName, () => string>> = {
  'secret-key': () => randomBytes(32).toString('base64'),
  'local-token-user': () => randomBytes(32).toString('base64url'),
  'local-token-ea': () => randomBytes(32).toString('base64url'),
}

function readValue(file: string): string | null {
  try {
    const value = fs.readFileSync(file, 'utf8').trim()
    return value === '' ? null : value
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
      return null
    }
    throw e
  }
}

/** Writes a generated credential unless another process got there first, then reads it back. */
function generate(source: CredentialSource, name: CredentialName, make: () => string): string | null {
  fs.mkdirSync(source.dir, { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(path.join(source.dir, name), `${make()}\n`, { flag: 'wx', mode: 0o600 })
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) {
      throw e
    }
  }
  return readValue(path.join(source.dir, name))
}

/** A credential's value, or null when it is missing or empty. */
export function credential(name: CredentialName, source: CredentialSource = CREDENTIALS): string | null {
  const value = readValue(path.join(source.dir, name))
  const make = GENERATED[name]
  if (value !== null || !source.dev || make === undefined) {
    return value
  }
  return generate(source, name, make)
}

/** Explains where a missing credential should come from, for startup errors. */
export function missingCredential(name: CredentialName, source: CredentialSource = CREDENTIALS): string {
  return (
    `Seti needs the key file ${name} in ${source.dir}. Run scripts/install.sh, which creates the ` +
    'missing ones, or set NODE_ENV=development for a development run with its own key files.'
  )
}
