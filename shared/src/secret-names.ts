/** Folders whose files hold keys or credentials, wherever they sit on the path. */
const SECRET_DIRS: ReadonlySet<string> = new Set(['.git', '.ssh', '.aws', '.gnupg', '.kube'])

/** Names of keys, credentials, env files and signing material, matched on every path segment. */
const SECRET_NAMES: readonly RegExp[] = [
  /^\.env/i,
  /\.env$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|ed25519|ecdsa)/i,
  /^credentials/i,
  /^\.(netrc|npmrc|pypirc)$/i,
  /^firebase-sa\.json$/i,
  /^(keystore|key|signing)\.properties$/i,
]

/**
 * Why a path names a key, credential or env file by its segments, or null when its name is fine.
 * Shares and the EA's reads refuse such files whatever the Files rules allow.
 */
export function secretNameProblem(file: string): string | null {
  const parts = file.split(/[\\/]/).filter((part) => part !== '')
  for (const [index, part] of parts.entries()) {
    if (SECRET_DIRS.has(part)) {
      return `is inside ${part}`
    }
    if (part === '.docker' && parts[index + 1] === 'config.json') {
      return 'is a Docker credentials file'
    }
    if (SECRET_NAMES.some((pattern) => pattern.test(part))) {
      return 'looks like a key, credential or env file'
    }
  }
  return null
}
