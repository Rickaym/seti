import fs from 'node:fs'
import path from 'node:path'
import { PackageProblem, type PackageReader } from './validate.js'
import { CREDENTIALS, SETI_HOME } from '../../config.js'
import { within } from '../../owned-dirs.js'

/** A package source Seti can read file by file, and how the UI names where it came from. */
export interface PackageSource {
  read: PackageReader
  /** The folder's real path, or the git commit. */
  ref: string
}

const realOrNull = (dir: string) => {
  try {
    return fs.realpathSync(dir)
  } catch {
    return null
  }
}

/** Seti's own data and key folders, which never hold a package. */
const forbiddenRoots = () => [SETI_HOME, CREDENTIALS.dir].map((dir) => realOrNull(dir) ?? path.resolve(dir))

/** Opens one listed file: every folder on the way and the file itself must be real, not links. */
async function readListed(root: string, relative: string, max: number): Promise<Buffer | null> {
  let at = root
  for (const part of relative.split('/')) {
    at = path.join(at, part)
    const stat = await fs.promises.lstat(at).catch(() => null)
    if (stat === null) {
      return null
    }
    if (stat.isSymbolicLink()) {
      throw new PackageProblem(`${relative} goes through a symlink, which a package cannot hold`)
    }
  }
  const handle = await fs.promises.open(at, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      throw new PackageProblem(`${relative} is not a regular file`)
    }
    if (stat.nlink > 1) {
      throw new PackageProblem(`${relative} is a hard link, which a package cannot hold`)
    }
    const buffer = Buffer.alloc(Math.min(stat.size, max + 1))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** A folder on the Seti host, such as an agent's workspace where an agent wrote the mod. */
export function folderSource(dir: string): PackageSource {
  if (!path.isAbsolute(dir)) {
    throw new PackageProblem('Give the folder as an absolute path')
  }
  const real = realOrNull(dir)
  if (real === null || !fs.statSync(real).isDirectory()) {
    throw new PackageProblem(`Seti cannot read the folder ${dir}`)
  }
  if (forbiddenRoots().some((root) => within(real, root) || within(root, real))) {
    throw new PackageProblem('Seti does not read mods from its own data or key folders')
  }
  return { read: async (relative, max) => readListed(real, relative, max), ref: real }
}
