import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { SharedToolCode } from '@seti/shared'
import { SHARED_TOOLS_ROOT } from './config.js'
import { removeOwnedDir } from './owned-dirs.js'

const MANIFEST = path.join('.claude-plugin', 'plugin.json')
const HASH_CHARS = 12
const READ_ONLY = 0o444
const RUNNABLE = 0o555

type Published = Pick<SharedToolCode, 'name' | 'sha256'>

/** What a tool's plugin folder is written from. */
type ToolFiles = Pick<SharedToolCode, 'name' | 'description' | 'file' | 'content' | 'sha256' | 'needs'>

/** The plugin name agents see the tool under; its skill is `seti-<name>:<name>`. */
export const toolPluginName = (name: string) => `seti-${name}`

/** One folder per published version, so a new version is a new plugin path for every session. */
export const toolFolder = (tool: Published) =>
  path.join(SHARED_TOOLS_ROOT, `${tool.name}-${tool.sha256.slice(0, HASH_CHARS)}`)

const skillDir = (tool: Pick<SharedToolCode, 'name'>) => path.join('skills', tool.name)

const INTERPRETERS: Readonly<Record<string, string>> = {
  '.py': 'python3',
  '.sh': 'bash',
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
}

/** How the skill tells an agent to start the script: by its first line, else by its extension. */
function runLine(tool: Pick<SharedToolCode, 'file' | 'content'>): string {
  const script = `"\${CLAUDE_SKILL_DIR}/${tool.file}"`
  if (tool.content.startsWith('#!')) {
    return script
  }
  const interpreter = INTERPRETERS[path.extname(tool.file).toLowerCase()]
  return interpreter === undefined ? script : `${interpreter} ${script}`
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The skill an agent reads: when to use the tool, how to run it and what it needs. */
function skillText(tool: ToolFiles): string {
  const needs = tool.needs.map((need) => `- \`${need.env}\`, sent to ${need.hosts.join(', ')}`)
  const needsText =
    needs.length === 0
      ? []
      : [
          'It reads these variables, which your credential carries as Seti placeholders:',
          '',
          ...needs,
          '',
          "Seti's proxy swaps in the real values on those hosts only. Never print them or ask for the keys.",
          '',
        ]
  return [
    '---',
    `name: ${tool.name}`,
    `description: ${JSON.stringify(oneLine(tool.description))}`,
    '---',
    '',
    `# ${tool.name}`,
    '',
    tool.description,
    '',
    'Run the script with Bash, adding its arguments:',
    '',
    '```',
    runLine(tool),
    '```',
    '',
    ...needsText,
    'This is a shared tool: an agent proposed the script and the user allowed it for every agent. It runs',
    'with your own access and nothing more. Its files are read-only; to change it, propose a new version',
    'with request_change.',
    '',
  ].join('\n')
}

function manifestText(tool: ToolFiles): string {
  const manifest = {
    name: toolPluginName(tool.name),
    version: tool.sha256.slice(0, HASH_CHARS),
    description: oneLine(tool.description),
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** The files of the tool's plugin folder, by path inside it, with the mode each is written with. */
function folderFiles(tool: ToolFiles): { rel: string; text: string; mode: number }[] {
  return [
    { rel: MANIFEST, text: manifestText(tool), mode: READ_ONLY },
    { rel: path.join(skillDir(tool), 'SKILL.md'), text: skillText(tool), mode: READ_ONLY },
    {
      rel: path.join(skillDir(tool), tool.file),
      text: tool.content,
      mode: tool.content.startsWith('#!') ? RUNNABLE : READ_ONLY,
    },
  ]
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Whether the folder holds exactly the files the published tool makes. */
const intact = (dir: string, tool: ToolFiles) =>
  folderFiles(tool).every(({ rel, text }) => readOrNull(path.join(dir, rel)) === text)

/** Whether the tool's plugin folder is on disk for a session to load. */
export const toolFolderReady = (tool: Published) => fs.existsSync(path.join(toolFolder(tool), MANIFEST))

async function removeFolder(dir: string): Promise<void> {
  const refusal = await removeOwnedDir(dir, 'sharedTools', [])
  if (refusal !== null) {
    throw new Error(`Seti cannot remove the shared tool folder: ${refusal}`)
  }
}

/** Writes the tool's plugin folder next to its final place, then moves it there in one step. */
export async function writeToolFolder(tool: ToolFiles): Promise<string> {
  const dir = toolFolder(tool)
  if (intact(dir, tool)) {
    return dir
  }
  fs.mkdirSync(SHARED_TOOLS_ROOT, { recursive: true, mode: 0o700 })
  if (fs.lstatSync(dir, { throwIfNoEntry: false }) !== undefined) {
    await removeFolder(dir)
  }
  const staging = path.join(SHARED_TOOLS_ROOT, `staging-${randomUUID()}`)
  for (const { rel, text, mode } of folderFiles(tool)) {
    fs.mkdirSync(path.dirname(path.join(staging, rel)), { recursive: true })
    fs.writeFileSync(path.join(staging, rel), text, { mode, flag: 'wx' })
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
