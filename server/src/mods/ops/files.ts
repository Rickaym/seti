import path from 'node:path'
import { globCouldContain, globMatches, MOD_LIMITS, type FileEntry, type Task, secretNameProblem } from '@seti/shared'
import { z } from 'zod'
import { refuseDelegateSecretFile, textForReader } from '../../ea-files.js'
import { HttpError } from '../../http.js'
import { sandboxContext } from '../../session-options.js'
import { sandboxPolicy } from '../../store/sandbox.js'
import { listDir } from '../../task-files-list.js'
import { fileRules, locate, readFile, taskRoots, type FileContext, type Located } from '../../task-files.js'
import type { ModCall } from '../capabilities.js'
import { grantOf, visibleTask } from '../scopes.js'
import { defineOp } from './define.js'

const where = {
  agentId: z.string().min(1).max(100),
  root: z.string().min(1).max(200).optional(),
}

interface Granted {
  files: FileContext
  root: string
  globs: readonly string[]
}

async function contextOf(task: Task): Promise<FileContext> {
  const rules = fileRules(task.id, await sandboxPolicy.get(), sandboxContext())
  return { task, rules, roots: taskRoots(task, rules) }
}

/** The agent's files as the grant reaches them: its filter, its globs and a root it has open. */
async function granted(call: ModCall, agent: string, root: string | undefined): Promise<Granted> {
  const grant = grantOf(call, 'files.read')
  const files = await contextOf(await visibleTask(grant.agents, agent))
  const open = files.roots.find((entry) => entry.real !== null && (root === undefined || entry.id === root))
  if (open === undefined) {
    throw new HttpError(404, root === undefined ? 'That agent has no folder open' : `${root} is not an open folder`)
  }
  return { files, root: open.id, globs: grant.paths }
}

const outside = (call: ModCall, rel: string) =>
  new HttpError(403, `${rel} is outside the paths the mod ${call.modId} was granted`)

/** The real path as a path inside its root, so a link inside the root is held to the globs too. */
const realRel = (at: Located) =>
  at.real === null ? at.rel : path.relative(at.root.real, at.real).split(path.sep).join('/')

/** Lists what the globs could reach: folders that may hold a match, and files that match. */
function shown(entry: FileEntry, globs: readonly string[]): boolean {
  if (secretNameProblem(entry.path) !== null) {
    return false
  }
  return entry.type === 'dir'
    ? globs.some((glob) => globCouldContain(glob, entry.path))
    : globs.some((glob) => globMatches(glob, entry.path))
}

/** An agent's files, read-only, within the grant's globs; never a key, credential or env file. */
export const fileOps = {
  'files.list': defineOp({
    args: z.strictObject({ ...where, dir: z.string().max(1000).optional() }),
    run: async (args, { call }) => {
      const { files, root, globs } = await granted(call, args.agentId, args.root)
      const dir = args.dir ?? ''
      const at = locate(files, root, dir)
      if (!globs.some((glob) => globCouldContain(glob, at.rel)) || secretNameProblem(at.rel) !== null) {
        throw outside(call, at.rel === '' ? '.' : at.rel)
      }
      const listing = listDir(at, files, { sort: 'name', dotfiles: false, seti_files: false })
      const entries = listing.entries.filter((entry) => shown(entry, globs))
      return {
        root,
        path: listing.path,
        entries: entries.map(({ name, path: rel, type, size }) => ({ name, path: rel, type, size })),
      }
    },
  }),
  'files.read': defineOp({
    args: z.strictObject({ ...where, path: z.string().min(1).max(1000) }),
    run: async (args, { call }) => {
      const { files, root, globs } = await granted(call, args.agentId, args.root)
      const at = locate(files, root, args.path)
      refuseDelegateSecretFile(at)
      if (!globs.some((glob) => globMatches(glob, at.rel) && globMatches(glob, realRel(at)))) {
        throw outside(call, at.rel)
      }
      const { meta, text } = readFile(at, true)
      if (meta.size > MOD_LIMITS.fileBytes) {
        throw new HttpError(413, `${at.rel} is over ${String(MOD_LIMITS.fileBytes / 1024)} KB, more than a mod reads`)
      }
      if (text === null || /[\0\uFFFD]/.test(text)) {
        throw new HttpError(415, `${at.rel} is not a text file`)
      }
      return { path: at.rel, size: meta.size, mtime: meta.mtime, text: textForReader(text) }
    },
  }),
}
