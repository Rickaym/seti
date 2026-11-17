import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  definitionText,
  toolDefinition,
  type SharedToolCode,
  type SharedToolDefinition,
  type SharedToolManifest,
} from '@seti/shared'
import { SHARED_TOOLS_ROOT } from './config.js'
import { removeOwnedDir } from './owned-dirs.js'
import { sha256 } from './task-files.js'

const MANIFEST = 'tool.json'
const HASH_CHARS = 12
const READ_ONLY = 0o444

type Published = Pick<SharedToolCode, 'name' | 'sha256'>

/** What a tool's folder is written from: its definition and its script. */
export type ToolFiles = SharedToolDefinition & { content: string }

/** The hash of a tool: its definition and its script, so a change to either is a new version. */
export const toolHash = (tool: ToolFiles) => sha256(`${definitionText(tool)}\n${tool.content}`)

/** One folder per published version, so a new version is a new path for every session. */
export const toolFolder = (tool: Published) =>
  path.join(SHARED_TOOLS_ROOT, `${tool.name}-${tool.sha256.slice(0, HASH_CHARS)}`)

const INTERPRETERS: Readonly<Record<string, string>> = {
  '.py': 'python3',
  '.sh': 'bash',
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
}

/** The program that starts the script: what its first line names, else what its extension does. */
export function runPrefix(tool: Pick<ToolFiles, 'file' | 'content'>): string[] {
  const shebang = /^#!\s*(\S+)(?:[ \t]+(\S+))?/.exec(tool.content)
  if (shebang !== null) {
    return [shebang[1] ?? '', ...(shebang[2] === undefined ? [] : [shebang[2]])]
  }
  const interpreter = INTERPRETERS[path.extname(tool.file).toLowerCase()]
  return interpreter === undefined ? [] : [interpreter]
}

function manifestText(tool: ToolFiles): string {
  const manifest: SharedToolManifest = { ...toolDefinition(tool), run: runPrefix(tool) }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** The files of the tool's folder, by name: what the tool server reads, and the script. */
const folderFiles = (tool: ToolFiles): { name: string; text: string }[] => [
  { name: MANIFEST, text: manifestText(tool) },
  { name: tool.file, text: tool.content },
]

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Whether the folder holds exactly the files the published tool makes. */
const intact = (dir: string, tool: ToolFiles) =>
  folderFiles(tool).every(({ name, text }) => readOrNull(path.join(dir, name)) === text)

/** Whether the tool's folder is on disk for a session to load. */
export const toolFolderReady = (tool: Published) => fs.existsSync(path.join(toolFolder(tool), MANIFEST))

async function removeFolder(dir: string): Promise<void> {
  const refusal = await removeOwnedDir(dir, 'sharedTools', [])
  if (refusal !== null) {
    throw new Error(`Seti cannot remove the shared tool folder: ${refusal}`)
  }
}

/** Writes the tool's folder next to its final place, then moves it there in one step. */
export async function writeToolFolder(tool: ToolFiles & { sha256: string }): Promise<string> {
  const dir = toolFolder(tool)
  if (intact(dir, tool)) {
    return dir
  }
  fs.mkdirSync(SHARED_TOOLS_ROOT, { recursive: true, mode: 0o700 })
  if (fs.lstatSync(dir, { throwIfNoEntry: false }) !== undefined) {
    await removeFolder(dir)
  }
  const staging = path.join(SHARED_TOOLS_ROOT, `staging-${randomUUID()}`)
  fs.mkdirSync(staging)
  for (const { name, text } of folderFiles(tool)) {
    fs.writeFileSync(path.join(staging, name), text, { mode: READ_ONLY, flag: 'wx' })
  }
  fs.renameSync(staging, dir)
  return dir
}

/** Removes every folder in the root that no published tool names; one in use stays for next time. */
export async function removeOtherFolders(tools: readonly Published[]): Promise<void> {
  const kept = new Set(tools.map(toolFolder))
  const entries = fs.existsSync(SHARED_TOOLS_ROOT) ? fs.readdirSync(SHARED_TOOLS_ROOT) : []
  for (const dir of entries.map((entry) => path.join(SHARED_TOOLS_ROOT, entry)).filter((entry) => !kept.has(entry))) {
    await removeOwnedDir(dir, 'sharedTools', [])
  }
}
