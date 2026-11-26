import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** The git checkout a folder sits in, or null when no folder from it up to the root has `.git`. */
export function gitCheckoutAbove(dir: string): string | null {
  let current = path.resolve(dir)
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

/**
 * Writes `text` to `<dir>/<name>`, mode 600, through a new temporary file renamed over the old
 * one, so a reader never sees half of it. Returns the file's path.
 */
export function writePrivateFile(dir: string, name: string, text: string): string {
  const file = path.join(dir, name)
  const temp = path.join(dir, `.${name}.${randomUUID()}.tmp`)
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
  try {
    fs.fchmodSync(fd, 0o600)
    fs.writeFileSync(fd, text)
    fs.fsyncSync(fd)
  } catch (e) {
    fs.closeSync(fd)
    fs.unlinkSync(temp)
    throw e
  }
  fs.closeSync(fd)
  fs.renameSync(temp, file)
  return file
}
