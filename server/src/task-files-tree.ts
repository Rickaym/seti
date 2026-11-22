import fs from 'node:fs'
import path from 'node:path'
import type { FileEntry, TreeEntry, TreeListing } from '@seti/shared'
import { gitBadge } from './git-state.js'
import { agentGitWithin } from './git.js'
import { rebuildableKind } from './rebuildable.js'
import { isRepoRoot } from './sandbox-mounts.js'
import { cachedSize, measuring } from './size-cache.js'
import { listDir } from './task-files-list.js'
import { within, type FileContext, type Located } from './task-files.js'

const IGNORE_TIMEOUT_MS = 3000

/** Whether git ignores a build output folder, asked of the nearest repository inside the root. */
async function ignoredByGit(dir: string, root: string): Promise<boolean> {
  for (let repo = path.dirname(dir); within(repo, root); repo = path.dirname(repo)) {
    if (isRepoRoot(repo)) {
      return agentGitWithin(IGNORE_TIMEOUT_MS, repo, 'check-ignore', '--quiet', '--', path.relative(repo, dir)).then(
        () => true,
        () => false,
      )
    }
    if (repo === root) {
      break
    }
  }
  return false
}

async function rebuildable(dir: string, root: string): Promise<boolean> {
  const kind = rebuildableKind(dir)
  return kind === 'always' || (kind === 'ignored' && (await ignoredByGit(dir, root)))
}

async function treeEntry(entry: FileEntry, at: Located & { real: string }): Promise<TreeEntry> {
  const base = { name: entry.name, path: entry.path, type: entry.type, mtime: entry.mtime }
  if (entry.type === 'file') {
    return { ...base, size: { bytes: entry.size, files: 1, capped: false }, git: null, rebuildable: false }
  }
  const real = fs.realpathSync(path.join(at.real, entry.name))
  return {
    ...base,
    size: cachedSize(real),
    git: await gitBadge(real),
    rebuildable: await rebuildable(real, at.root.real),
  }
}

/**
 * One folder of the tree: its entries as the Files view lists them, each folder with its last
 * measured size, its git badge and whether it is rebuildable. Sizes are measured in the
 * background; `measuring` says some are on their way.
 */
export async function listTree(
  at: Located,
  files: FileContext,
  options: { dotfiles: boolean; setiFiles: boolean },
): Promise<TreeListing> {
  const listing = listDir(at, files, { sort: 'name', dotfiles: options.dotfiles, seti_files: options.setiFiles })
  const real = at.real ?? at.root.real
  const entries = await Promise.all(listing.entries.map(async (entry) => treeEntry(entry, { ...at, real })))
  const size = cachedSize(real)
  return {
    root: at.root.id,
    path: at.rel,
    size,
    entries,
    truncated: listing.truncated,
    measuring: (size === null || entries.some((entry) => entry.size === null)) && measuring(),
  }
}
