import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { MOD_PACKAGE_LIMITS } from '@seti/shared'
import type { PackageSource } from './read-folder.js'
import { PackageProblem } from './validate.js'
import { binaryPath } from '../../binaries.js'
import { OWNED_ROOTS, removeOwnedDir } from '../../owned-dirs.js'

/** No prompts, config, hooks, submodules, LFS or redirects; https only. */
const CONFIG = [
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.https.allow=always',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'submodule.recurse=false',
  '-c',
  'credential.helper=',
  '-c',
  'http.followRedirects=false',
]

const envFor = (home: string) => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: home,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_LFS_SKIP_SMUDGE: '1',
})

async function dirBytes(dir: string): Promise<number> {
  const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  const sizes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(
        async (entry) => (await fs.promises.stat(path.join(entry.parentPath, entry.name)).catch(() => null))?.size ?? 0,
      ),
  )
  return sizes.reduce((sum, size) => sum + size, 0)
}

interface Run {
  gitDir: string
  args: string[]
  /** Stops the run once stdout passes this many bytes. */
  outMax?: number
  /** Stops the run once the git directory passes the fetch cap. */
  watchSize?: boolean
}

/** Runs git on the bare repository with an argument list, killing its exact PID past a cap. */
async function git({ gitDir, args, outMax = 1024 * 1024, watchSize = false }: Run): Promise<Buffer> {
  const bin = binaryPath('git')
  if (bin === null) {
    throw new PackageProblem('git is not installed on the Seti host')
  }
  const child = spawn(bin, [...CONFIG, '--git-dir', gitDir, ...args], {
    env: envFor(path.dirname(gitDir)),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out: Buffer[] = []
  let outBytes = 0
  let stderr = ''
  const state: { stopped: string | null } = { stopped: null }
  const stop = (why: string) => {
    state.stopped ??= why
    if (child.pid !== undefined) {
      process.kill(child.pid, 'SIGKILL')
    }
  }
  child.stdout.on('data', (chunk: Buffer) => {
    outBytes += chunk.length
    out.push(chunk)
    if (outBytes > outMax) {
      stop('it sent more than Seti reads')
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-2000)
  })
  const timer = setTimeout(() => {
    stop('it took longer than a minute')
  }, MOD_PACKAGE_LIMITS.gitTimeoutMs)
  const sizer = watchSize
    ? setInterval(() => {
        void dirBytes(gitDir).then((bytes) => {
          if (bytes > MOD_PACKAGE_LIMITS.gitFetchBytes) {
            stop('the repository is over 20 MB')
          }
        })
      }, 250)
    : null
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
  clearTimeout(timer)
  if (sizer !== null) {
    clearInterval(sizer)
  }
  if (state.stopped !== null) {
    throw new PackageProblem(`Seti stopped reading the repository: ${state.stopped}`)
  }
  if (code !== 0) {
    const reason = stderr.trim().split('\n').at(-1) ?? ''
    const why = reason === '' ? '' : `: ${reason}`
    throw new PackageProblem(`git could not read the repository${why}`)
  }
  return Buffer.concat(out)
}

interface TreeEntry {
  mode: string
  object: string
}

const LINK_MODES: Readonly<Record<string, string>> = { '120000': 'a symlink', '160000': 'a submodule' }

/** Reads files of one commit straight from the object store; a symlink or submodule refuses it. */
export async function treeReader(gitDir: string, commit: string): Promise<PackageSource> {
  const listing = await git({ gitDir, args: ['ls-tree', '-r', '-z', '--full-tree', commit], outMax: 8 * 1024 * 1024 })
  const tree = new Map<string, TreeEntry>()
  for (const line of listing.toString('utf8').split('\0').filter(Boolean)) {
    const [meta = '', file = ''] = line.split('\t')
    const [mode = '', , object = ''] = meta.split(' ')
    const link = LINK_MODES[mode]
    if (link !== undefined) {
      throw new PackageProblem(`${file} is ${link}, which a package cannot hold`)
    }
    tree.set(file, { mode, object })
  }
  return {
    ref: commit,
    read: async (relative, max) => {
      const entry = tree.get(relative)
      if (entry === undefined) {
        return null
      }
      return git({ gitDir, args: ['cat-file', 'blob', entry.object], outMax: max + 1 }).catch((e: unknown) => {
        if (e instanceof PackageProblem && e.message.includes('more than Seti reads')) {
          throw new PackageProblem(`${relative} is over ${String(max / 1024)} KB`)
        }
        throw e
      })
    },
  }
}

const COMMIT = /^[a-f0-9]{40}$/

/**
 * Fetches one commit of an https repository into a bare repository Seti owns, never checking out
 * a working tree, hands its files to `use`, and removes the repository after.
 */
export async function withGitSource<T>(
  url: string,
  ref: string,
  use: (source: PackageSource) => Promise<T>,
): Promise<T> {
  if (!url.startsWith('https://')) {
    throw new PackageProblem('Seti fetches mods over https only')
  }
  const root = OWNED_ROOTS.modFetch
  await fs.promises.mkdir(root, { recursive: true })
  const dir = await fs.promises.mkdtemp(path.join(root, 'git-'))
  try {
    const gitDir = path.join(dir, 'repo.git')
    await git({ gitDir, args: ['init', '--bare', '-q'] })
    await git({ gitDir, args: ['fetch', '--depth', '1', '--no-tags', '--', url, ref], watchSize: true })
    const commit = (await git({ gitDir, args: ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'] })).toString().trim()
    if (!COMMIT.test(commit)) {
      throw new PackageProblem(`git did not resolve ${ref} to a commit`)
    }
    return await use(await treeReader(gitDir, commit))
  } finally {
    const refused = await removeOwnedDir(dir, 'modFetch', [])
    if (refused !== null) {
      process.stderr.write(`mods: the fetched repository stays at ${dir}: ${refused}\n`)
    }
  }
}
