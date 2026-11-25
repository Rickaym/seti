import fs from 'node:fs'
import path from 'node:path'

/**
 * A folder's runtime settings: Claude Code's permission rules and hooks, its tool servers, and
 * Codex's folder config, which an agent's runtime, and later the user's own, loads.
 */
const FOLDER_SETTINGS = ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks', '.mcp.json', '.codex']

/** The settings of each working folder that exist, covered read-only as git hooks and config are. */
export const folderSettingsGuards = (dirs: readonly string[]): string[] =>
  dirs.flatMap((dir) => FOLDER_SETTINGS.map((entry) => path.join(dir, entry))).filter((file) => fs.existsSync(file))
