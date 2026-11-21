import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { FILE_TEXT_MAX, isTextKind, type FileStamp } from '@seti/shared'
import { HttpError } from './http.js'
import { GONE, readFile, stampOf, type FileContext, type Located } from './task-files.js'

/** The save refused because the file changed since the editor loaded it. */
export class FileConflictError extends Error {
  readonly current: FileStamp

  constructor(current: FileStamp) {
    super('The file changed on disk since you opened it')
    this.current = current
  }
}

function writeNew(parent: string, name: string, text: string): void {
  fs.mkdirSync(parent, { recursive: true })
  if (fs.realpathSync(parent) !== parent) {
    throw new HttpError(409, `The folder of ${name} moved while it was created`)
  }
  const fd = fs.openSync(path.join(parent, name), 'wx', 0o644)
  try {
    fs.writeFileSync(fd, text)
  } finally {
    fs.closeSync(fd)
  }
}

/** Swaps the file for one holding `text`, keeping its mode; readers never see half a file. */
function replace(real: string, text: string): void {
  const mode = fs.statSync(real).mode & 0o7777
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.${randomUUID()}.seti-tmp`)
  const fd = fs.openSync(tmp, 'wx', mode)
  try {
    fs.writeFileSync(fd, text)
    fs.fchmodSync(fd, mode)
    fs.closeSync(fd)
    fs.renameSync(tmp, real)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

export interface SaveRequest {
  text: string
  baseHash: string | null
  dotfiles: boolean
}

function create(files: FileContext, at: Located, save: SaveRequest): void {
  if (save.baseHash !== null) {
    throw new FileConflictError(GONE)
  }
  try {
    writeNew(at.parent, path.basename(at.rel), save.text)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new FileConflictError(stampOf(files, at, save.dotfiles))
    }
    throw e
  }
}

/** Saves a text file when it still holds what the editor loaded; a null base creates it. */
export function saveText(files: FileContext, at: Located, save: SaveRequest): { created: boolean; bytes: number } {
  if (!at.root.writable) {
    throw new HttpError(403, `${at.root.label} is read-only here`)
  }
  const bytes = Buffer.byteLength(save.text)
  if (bytes > FILE_TEXT_MAX) {
    throw new HttpError(413, 'The text is larger than the editor saves')
  }
  if (at.real === null) {
    create(files, at, save)
    return { created: true, bytes }
  }
  const { meta } = readFile(at, false)
  if (!isTextKind(meta.kind) || meta.hash === null) {
    throw new HttpError(415, `${at.rel} is not a text file the editor can save`)
  }
  if (save.baseHash !== meta.hash) {
    throw new FileConflictError({ exists: true, size: meta.size, mtime: meta.mtime, hash: meta.hash })
  }
  replace(at.real, save.text)
  return { created: false, bytes }
}
