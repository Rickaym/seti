import fs from 'node:fs'
import path from 'node:path'

const PACKAGES: Record<string, string> = { bwrap: 'bubblewrap', setpriv: 'util-linux' }

/** The absolute path of a program on PATH, or null when no directory on it has the program. */
export function binaryPath(name: string, searchPath: string = process.env.PATH ?? ''): string | null {
  for (const dir of searchPath.split(':').filter((entry) => path.isAbsolute(entry))) {
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

/** The absolute path of a program on PATH; throws saying what to install when it is missing. */
export function findBinary(name: string, searchPath: string = process.env.PATH ?? ''): string {
  const found = binaryPath(name, searchPath)
  if (found !== null) {
    return found
  }
  const pkg = PACKAGES[name] ?? name
  throw new Error(`The agent sandbox needs ${name}; install it (sudo apt-get install ${pkg})`)
}
