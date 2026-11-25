import path from 'node:path'
import { USER_SKILLS } from '../../sandbox-codex.js'
import type { UserSkill } from '../../user-skills.js'

/**
 * The user's skills as the agent's instructions list them, each with its SKILL.md in the
 * sandbox's read-only copy. Codex's own skill list stays off, so no skill an agent writes into a
 * folder Codex reads is ever offered.
 */
function skillsText(skills: readonly UserSkill[], home: string): string {
  if (skills.length === 0) {
    return ''
  }
  const rows = skills.map(
    (skill) =>
      `- ${skill.name}: ${skill.description} (file: ${path.join(home, USER_SKILLS, skill.folder, 'SKILL.md')})`,
  )
  return [
    "## The user's skills",
    "Each is a read-only SKILL.md of instructions for a kind of task. When a task matches one, or the user names it, read that file first and follow it; paths it names are relative to the skill's folder.",
    ...rows,
  ].join('\n')
}

/** The agent's instructions with the user's skills after them. */
export const withSkills = (append: string, skills: readonly UserSkill[], home: string | undefined): string =>
  [append, home === undefined ? '' : skillsText(skills, home)].filter((part) => part !== '').join('\n\n')
