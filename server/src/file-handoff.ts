import fs from 'node:fs'
import path from 'node:path'
import {
  archivedRefusal,
  formatBytes,
  TEAM_FILE_BYTES_MAX,
  TEAM_INBOX_DIR,
  TEAM_TEXT_MAX,
  type AuditActor,
  type Task,
  type TeamFileCopy,
  type TeamFileInput,
  type TeamFileSent,
  type TeamPosted,
  secretNameProblem,
} from '@seti/shared'
import { audit } from './audit.js'
import { tasks } from './db.js'
import { HttpError } from './http.js'
import { sandboxContext } from './session-options.js'
import { sandboxPolicy } from './store/sandbox.js'
import { teamMembers } from './store/team.js'
import { fileRules, isHidden, openChecked, pathProblem, taskRoots, within, type FileContext } from './task-files.js'
import { ensureMember, postTeamMessage } from './team.js'
import { workspaceDir, WORKSPACE_ENV } from './workspace/dir.js'
import { copyInto } from './workspace/files.js'

const NAME_MAX = 80
const EXT_MAX = 16

/** The folders the task's agent works in, as the Files view and its sandbox see them. */
async function reachOf(task: Task): Promise<FileContext> {
  const rules = fileRules(task.id, await sandboxPolicy.get(), sandboxContext())
  return { task, rules, roots: taskRoots(task, rules) }
}

/** A file the sender may hand over, held open so that a later swap cannot change what is copied. */
interface Source {
  raw: string
  /** The real path, which the EA reads the file at through the sender's Files. */
  real: string
  name: string
  fd: number
  size: number
}

const refuse = (status: 400 | 403 | 404 | 413, raw: string, why: string) => new HttpError(status, `${raw} ${why}`)

/** The path as the agent means it: absolute, under its workspace variable, or under its cwd. */
function lexicalPath(raw: string, task: Task): string {
  if (raw.includes('\0')) {
    throw new HttpError(400, 'Paths cannot hold NUL bytes')
  }
  if (raw.split(/[\\/]/).includes('..')) {
    throw refuse(403, raw, 'climbs with ..; give the path itself')
  }
  const variable = `$${WORKSPACE_ENV}`
  const expanded =
    raw === variable || raw.startsWith(`${variable}/`) ? workspaceDir(task.id) + raw.slice(variable.length) : raw
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.join(task.cwd, expanded)
}

function realOf(lexical: string, raw: string): string {
  try {
    return fs.realpathSync(lexical)
  } catch {
    throw refuse(404, raw, 'does not exist')
  }
}

/** Letters, digits and . _ + - only, so the name cannot carry mentions, Markdown or new lines. */
function safeName(name: string): string {
  const plain = (text: string) => text.replace(/[^\w.+-]+/g, '-')
  const ext = path.extname(name)
  const tail = plain(ext).slice(0, EXT_MAX)
  const stem = plain(name.slice(0, name.length - ext.length))
  let start = 0
  let end = stem.length
  while (start < end && '.-'.includes(stem.charAt(start))) {
    start += 1
  }
  while (end > start && stem.charAt(end - 1) === '-') {
    end -= 1
  }
  const base = start === end ? 'file' : stem.slice(start, end).slice(0, NAME_MAX - tail.length)
  return tail.length > 1 ? base + tail : base
}

/** Opens one source after checking it is a regular file the sender can reach, within the cap. */
function openSource(raw: string, files: FileContext): Source {
  const lexical = lexicalPath(raw, files.task)
  if (isHidden(lexical, files.rules)) {
    throw refuse(403, raw, 'is a hidden path')
  }
  const real = realOf(lexical, raw)
  if (!files.roots.some((root) => root.real !== null && within(real, root.real))) {
    throw refuse(403, raw, 'is outside your working folders and workspace')
  }
  const problem = pathProblem(real, files.rules)
  if (problem !== null) {
    throw refuse(403, raw, problem)
  }
  const stat = fs.statSync(real)
  if (stat.isDirectory()) {
    throw refuse(400, raw, 'is a folder; send the files in it, or an archive of it')
  }
  if (!stat.isFile()) {
    throw refuse(400, raw, 'is not a regular file')
  }
  const fd = openChecked(real)
  const size = fs.fstatSync(fd).size
  if (size > TEAM_FILE_BYTES_MAX) {
    fs.closeSync(fd)
    throw refuse(413, raw, `is ${formatBytes(size)}; files are limited to ${formatBytes(TEAM_FILE_BYTES_MAX)}`)
  }
  return { raw, real, name: safeName(path.basename(lexical)), fd, size }
}

function openSources(raws: readonly string[], files: FileContext): Source[] {
  const opened: Source[] = []
  try {
    for (const raw of raws) {
      opened.push(openSource(raw, files))
    }
    return opened
  } catch (e) {
    closeAll(opened)
    throw e
  }
}

function closeAll(sources: readonly Source[]): void {
  for (const source of sources) {
    fs.closeSync(source.fd)
  }
}

async function recipientOf(handle: string, from: Task): Promise<{ task: Task; handle: string }> {
  const [member] = await teamMembers.byHandles([handle])
  const task = member === undefined ? undefined : await tasks.get(member.task_id)
  if (member === undefined || task === undefined) {
    throw new HttpError(404, `No agent has the handle @${handle}`)
  }
  if (task.archived_at !== null) {
    throw new HttpError(409, archivedRefusal(task.title))
  }
  if (task.id === from.id) {
    throw new HttpError(400, 'Those files are already yours; send them to another agent')
  }
  return { task, handle: member.handle }
}

/** Copies every source into the inbox, removing what it copied when one copy fails. */
async function copyAll(root: string, sender: string, sources: readonly Source[]): Promise<string[]> {
  const placed: string[] = []
  try {
    for (const source of sources) {
      const rel = await copyInto(root, path.join(TEAM_INBOX_DIR, sender, source.name), source.fd, source.size)
      placed.push(path.join(root, rel))
    }
    return placed
  } catch (e) {
    for (const file of placed) {
      fs.rmSync(file, { force: true })
    }
    throw e
  }
}

/** The chat message naming the recipient, the note and each copy's full path. */
function handoffText(to: string, files: readonly TeamFileCopy[], note: string | undefined): string {
  const count = files.length === 1 ? 'A file' : `${String(files.length)} files`
  const head = `@${to} ${count} for you, in your inbox`
  const list = files.map((file) => `- \`${file.path}\``).join('\n')
  const room = TEAM_TEXT_MAX - head.length - list.length - 3
  return `${head}${noteLine(note, room)}\n${list}`
}

function noteLine(note: string | undefined, room: number): string {
  if (note === undefined || note === '' || room < 4) {
    return '.'
  }
  const shown = note.length <= room ? note : `${note.slice(0, room - 3)}...`
  return `: ${shown}`
}

interface HandoffBy {
  actor: Extract<AuditActor, 'user' | 'agent'>
}

interface Handed {
  to: string
  toTask: Task | null
  files: TeamFileCopy[]
  posted: TeamPosted
}

/** Copies the files into the receiving agent's inbox and mentions it with each copy's path. */
async function handToAgent(from: Task, sender: string, input: TeamFileInput): Promise<Handed> {
  const recipient = await recipientOf(input.to, from)
  const sources = openSources(input.paths, await reachOf(from))
  const root = workspaceDir(recipient.task.id)
  let placed: string[]
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    placed = await copyAll(root, sender, sources)
  } finally {
    closeAll(sources)
  }
  const files = sources.map((source, i) => ({ source: source.raw, path: placed[i] ?? '', bytes: source.size }))
  const posted = await postTeamMessage(
    { kind: 'task', taskId: from.id },
    handoffText(recipient.handle, files, input.note),
  )
  return { to: recipient.handle, toTask: recipient.task, files, posted }
}

/** The direct message that names, for the EA, each file where the sender keeps it. */
function eaHandoffText(files: readonly TeamFileCopy[], note: string | undefined): string {
  const count = files.length === 1 ? 'A file' : `${String(files.length)} files`
  const head = `${count} for you to read in my files`
  const list = files.map((file) => `- \`${file.path}\``).join('\n')
  return `${head}${noteLine(note, TEAM_TEXT_MAX - head.length - list.length - 3)}\n${list}`
}

/** Why the EA would not open a file its sender may send, or null when it would. */
function eaProblem(source: Source, files: FileContext): string | null {
  const secret = secretNameProblem(source.raw) ?? secretNameProblem(source.real)
  if (secret !== null) {
    return `${secret}; the EA never reads those`
  }
  const root = files.roots
    .map((each) => each.real)
    .find((real): real is string => real !== null && within(source.real, real))
  const rel = root === undefined ? '' : path.relative(root, source.real)
  return rel.split(path.sep).some((part) => part.startsWith('.')) ? 'is a dot file, which the EA does not open' : null
}

/**
 * The EA has no workspace, so it gets no copy: Seti checks each file as for an agent, refuses
 * key, credential and env files, and sends the EA a direct message naming each real path, which
 * the EA reads through the sender's Files with the EA's own read rules.
 */
async function handToEa(from: Task, input: TeamFileInput): Promise<Handed> {
  const reach = await reachOf(from)
  const sources = openSources(input.paths, reach)
  closeAll(sources)
  for (const source of sources) {
    const problem = eaProblem(source, reach)
    if (problem !== null) {
      throw refuse(403, source.raw, problem)
    }
  }
  const files = sources.map((source) => ({ source: source.raw, path: source.real, bytes: source.size }))
  const posted = await postTeamMessage({ kind: 'task', taskId: from.id }, eaHandoffText(files, input.note), {
    to: 'ea',
  })
  return { to: 'ea', toTask: null, files, posted }
}

/**
 * Hands files from one agent to another, or to the EA. An agent gets copies in its workspace
 * inbox under the sender's handle and one group chat message that mentions it; the EA gets a
 * direct message naming the files where they are. Sources must resolve inside the sender's own
 * folders and pass the hidden-path rules.
 */
export async function sendFiles(from: Task, input: TeamFileInput, by: HandoffBy): Promise<TeamFileSent> {
  const sender = (await ensureMember(from)).handle
  const handed = input.to === 'ea' ? await handToEa(from, input) : await handToAgent(from, sender, input)
  const { files, posted } = handed
  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  const count = `${String(files.length)} ${files.length === 1 ? 'file' : 'files'}`
  await audit.record({
    actor: by.actor,
    kind: 'team.file_sent',
    subject_type: 'task',
    subject_id: from.id,
    summary: `@${sender} sent ${count} (${formatBytes(total)}) to @${handed.to}`,
    detail: {
      title: from.title,
      to_task_id: handed.toTask?.id ?? null,
      to_title: handed.toTask?.title ?? null,
      to: handed.to,
      message_id: String(posted.message.id),
      bytes: total,
      files: files.map((file) => `${file.source} -> ${file.path} (${formatBytes(file.bytes)})`),
      note: input.note ?? null,
    },
  })
  return { from: sender, to: handed.to, files, posted }
}
