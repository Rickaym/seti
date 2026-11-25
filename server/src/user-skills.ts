import fs from 'node:fs'
import path from 'node:path'
import { CLAUDE_HOME } from './config.js'

/** A skill of the user's own library: its name, what it is for, and its folder under the root. */
export interface UserSkill {
  name: string
  description: string
  folder: string
}

/** The most skills one agent is told about, and the longest description it reads of each. */
const MOST_SKILLS = 100
const LONGEST_DESCRIPTION = 400

/** The user's skills folder, which Claude Code agents load and Codex agents get read-only. */
const userSkillsRoot = () => path.join(CLAUDE_HOME, 'skills')

const oneLine = (text: string) =>
  text
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** A frontmatter value of SKILL.md on one line, without the quotes YAML may put around it. */
function field(head: string, key: string): string | null {
  const line = head.split('\n').find((row) => row.startsWith(`${key}:`))
  const value = line === undefined ? '' : oneLine(line.slice(key.length + 1)).replace(/^(["'])(.*)\1$/, '$2')
  return value === '' ? null : value
}

/** The text of a folder's SKILL.md when it is a file inside the root, else null. */
function skillText(realRoot: string, root: string, folder: string): string | null {
  try {
    const file = fs.realpathSync(path.join(root, folder, 'SKILL.md'))
    return file.startsWith(`${realRoot}/`) && fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null
  } catch {
    return null
  }
}

/** The skill in a folder whose SKILL.md lies inside the root, read from its frontmatter. */
function skillIn(realRoot: string, root: string, folder: string): UserSkill | null {
  const text = skillText(realRoot, root, folder)
  if (text === null) {
    return null
  }
  const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
  const description = field(head, 'description')
  if (description === null) {
    return null
  }
  return {
    name: field(head, 'name') ?? folder,
    description: description.slice(0, LONGEST_DESCRIPTION),
    folder,
  }
}

/**
 * The skills in the user's skills folder that a sandbox can read: each a folder whose SKILL.md
 * has a description and resolves inside the folder, so a link to elsewhere is left out.
 */
export function userSkills(root: string = userSkillsRoot()): UserSkill[] {
  let folders: string[]
  let realRoot: string
  try {
    realRoot = fs.realpathSync(root)
    folders = fs.readdirSync(root).filter((name) => !name.startsWith('.'))
  } catch {
    return []
  }
  return folders
    .toSorted((a, b) => a.localeCompare(b, 'en'))
    .flatMap((folder) => {
      const skill = skillIn(realRoot, root, folder)
      return skill === null ? [] : [skill]
    })
    .slice(0, MOST_SKILLS)
}
