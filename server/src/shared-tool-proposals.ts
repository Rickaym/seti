import fs from 'node:fs'
import path from 'node:path'
import {
  formatBytes,
  SHARED_TOOL_BYTES_MAX,
  type SharedToolChange,
  type SharedToolProposal,
  type Task,
} from '@seti/shared'
import { lexicalPath, reachOf } from './file-handoff.js'
import { HttpError } from './http.js'
import { sharedTools } from './store/shared-tools.js'
import { isHidden, openChecked, pathProblem, sha256, within } from './task-files.js'

const FILE_NAME = /^[A-Za-z0-9][\w.+-]{0,79}$/
const SKILL_FILE = 'skill.md'

const refuse = (status: 400 | 403 | 404 | 413, raw: string, why: string) => new HttpError(status, `${raw} ${why}`)

/** The real path of the one regular file the agent named, inside its own folders and no link. */
async function scriptPath(task: Task, raw: string): Promise<string> {
  const files = await reachOf(task)
  const lexical = lexicalPath(raw, task)
  if (isHidden(lexical, files.rules)) {
    throw refuse(403, raw, 'is a hidden path')
  }
  const stat = fs.lstatSync(lexical, { throwIfNoEntry: false })
  if (stat === undefined) {
    throw refuse(404, raw, 'does not exist')
  }
  if (stat.isSymbolicLink()) {
    throw refuse(403, raw, 'is a symlink; give the file itself')
  }
  if (!stat.isFile()) {
    throw refuse(400, raw, 'is not a regular file; a shared tool is one script')
  }
  const real = fs.realpathSync(lexical)
  if (!files.roots.some((root) => root.real !== null && within(real, root.real))) {
    throw refuse(403, raw, 'is outside your working folders and workspace')
  }
  const problem = pathProblem(real, files.rules)
  if (problem !== null) {
    throw refuse(403, raw, problem)
  }
  return real
}

/** Reads the script once through a descriptor, so a swap after the checks changes nothing. */
function readScript(real: string, raw: string): string {
  const fd = openChecked(real)
  try {
    const size = fs.fstatSync(fd).size
    if (size > SHARED_TOOL_BYTES_MAX) {
      const limit = formatBytes(SHARED_TOOL_BYTES_MAX)
      throw refuse(413, raw, `is ${formatBytes(size)}; a shared tool is one script of at most ${limit}`)
    }
    const bytes = fs.readFileSync(fd)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.trim() === '' || text.includes('\0')) {
      throw refuse(400, raw, 'is empty or not text')
    }
    return text
  } catch (e) {
    if (e instanceof TypeError) {
      throw refuse(400, raw, 'is not UTF-8 text')
    }
    throw e
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Reads the script the agent named and keeps it on the proposal, with the published version it
 * would replace. The user reviews this snapshot and Allow publishes it; later edits of the file
 * change nothing.
 */
export async function snapshotProposal(task: Task, proposal: SharedToolProposal): Promise<SharedToolChange> {
  const real = await scriptPath(task, proposal.path)
  const file = path.basename(real)
  if (!FILE_NAME.test(file) || file.toLowerCase() === SKILL_FILE) {
    throw refuse(400, proposal.path, 'needs a plain file name of letters, digits, dots, hyphens and underscores')
  }
  const content = readScript(real, proposal.path)
  const published = await sharedTools.get(proposal.name)
  return {
    ...proposal,
    snapshot: {
      file,
      content,
      sha256: sha256(content),
      replaces: published === undefined ? null : { sha256: published.sha256, content: published.content },
    },
  }
}

const sameNeeds = (a: SharedToolChange['needs'], b: SharedToolChange['needs']) =>
  JSON.stringify(a) === JSON.stringify(b)

/** Whether the proposal is what is published already: the same code, description and needs. */
export async function publishedAlready(change: SharedToolChange): Promise<boolean> {
  const published = await sharedTools.get(change.name)
  return (
    published?.sha256 === change.snapshot.sha256 &&
    published.file === change.snapshot.file &&
    published.description === change.description &&
    sameNeeds(published.needs, change.needs)
  )
}
