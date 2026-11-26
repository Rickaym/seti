import fs from 'node:fs'
import path from 'node:path'

const exists = (file: string) => fs.existsSync(file)

const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)

/** The git folders of a repository top: the shared one and the worktree's own. */
export interface GitDirs {
  common: string
  own: string
  linked: boolean
}

const real = (file: string) => {
  try {
    return fs.realpathSync(file)
  } catch {
    return file
  }
}

/**
 * Whether the repository a `.git` file names holds this folder as its own. Anyone who can write
 * the folder can write that file, so alone it proves nothing: a worktree counts when its admin
 * folder lies in the repository's `worktrees` and points back at it, and a submodule when its git
 * directory lies in the `.git/modules` of a checkout above it.
 */
function recorded(dir: string, own: string, common: string): boolean {
  if (own === common) {
    const marker = `${path.sep}.git${path.sep}modules${path.sep}`
    const at = own.indexOf(marker)
    return at > 0 && dir.startsWith(own.slice(0, at) + path.sep)
  }
  const back = path.join(own, 'gitdir')
  if (!within(own, path.join(common, 'worktrees')) || !exists(back)) {
    return false
  }
  const claimed = path.resolve(own, fs.readFileSync(back, 'utf8').trim())
  return real(claimed) === real(path.join(dir, '.git'))
}

/** The git folders of `dir` when it tops a repository: a `.git` folder, or a recorded `.git` file. */
export function gitDirs(dir: string): GitDirs | null {
  const dotGit = path.join(dir, '.git')
  const stat = fs.statSync(dotGit, { throwIfNoEntry: false })
  if (stat?.isDirectory() === true) {
    return { common: dotGit, own: dotGit, linked: false }
  }
  if (stat?.isFile() !== true) {
    return null
  }
  const text = fs.readFileSync(dotGit, 'utf8').trim()
  const pointer = text.startsWith('gitdir:') ? text.slice('gitdir:'.length).trim() : ''
  if (pointer === '') {
    return null
  }
  const own = path.resolve(dir, pointer)
  const commonFile = path.join(own, 'commondir')
  const common = exists(commonFile) ? path.resolve(own, fs.readFileSync(commonFile, 'utf8').trim()) : own
  return recorded(dir, own, common) ? { common, own, linked: true } : null
}

/** Whether `dir` tops a repository: a `.git` folder, or a `.git` file its repository records. */
export const isRepoRoot = (dir: string): boolean => gitDirs(dir) !== null

/** The nearest repository top at or above `dir`, with its git folders; null outside any. */
export function repoTop(dir: string): { top: string; git: GitDirs } | null {
  for (let current = dir; ; current = path.dirname(current)) {
    const git = gitDirs(current)
    if (git !== null) {
      return { top: current, git }
    }
    if (path.dirname(current) === current) {
      return null
    }
  }
}

/** The repository Claude Code files a directory's memory under: a worktree's main checkout. */
export function canonicalRoot(dir: string): string | null {
  const found = repoTop(dir)
  if (found === null) {
    return null
  }
  const { top, git } = found
  return git.linked && path.basename(git.common) === '.git' ? path.dirname(git.common) : top
}
