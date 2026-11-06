import type { ModSourceInput } from '@seti/shared'
import { HttpError } from '../../http.js'
import type { PackageOrigin } from '../consent.js'
import { folderSource } from './read-folder.js'
import { withGitSource } from './read-git.js'
import { PackageProblem, readPackage, type ValidPackage } from './validate.js'

/** Reads and checks a package from where the user pointed, as a 400 the user reads when refused. */
export async function readFrom(
  source: ModSourceInput | { kind: 'dev'; path: string },
  bundledIds: ReadonlySet<string>,
): Promise<{ pkg: ValidPackage; origin: PackageOrigin }> {
  try {
    if (source.kind === 'git') {
      return await withGitSource(source.url, source.ref, async (read) => ({
        pkg: await readPackage(read.read, bundledIds),
        origin: { kind: 'git', source: source.url, track: source.ref, commit: read.ref },
      }))
    }
    const folder = folderSource(source.path)
    return {
      pkg: await readPackage(folder.read, bundledIds),
      origin: { kind: source.kind, source: folder.ref, track: null, commit: null },
    }
  } catch (e) {
    if (e instanceof PackageProblem) {
      throw new HttpError(400, e.message)
    }
    throw e
  }
}

/** Reads the package an install follows again: its folder, or its git branch or tag. */
export async function readOrigin(origin: PackageOrigin, bundledIds: ReadonlySet<string>) {
  if (origin.kind === 'git') {
    return readFrom({ kind: 'git', url: origin.source, ref: origin.track ?? origin.commit ?? 'HEAD' }, bundledIds)
  }
  return readFrom({ kind: origin.kind, path: origin.source }, bundledIds)
}
