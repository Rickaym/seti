import fs from 'node:fs'
import path from 'node:path'
import { CLAUDE_HOME } from './config.js'

/** Files Claude Code rewrites when plugins or marketplaces change, from Seti or a terminal. */
export const pluginStateFiles = (home: string = CLAUDE_HOME) => [
  path.join(home, 'plugins', 'installed_plugins.json'),
  path.join(home, 'plugins', 'known_marketplaces.json'),
  path.join(home, 'settings.json'),
]

function signature(file: string): string {
  try {
    const stat = fs.statSync(file)
    return `${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeMs)}`
  } catch {
    return 'missing'
  }
}

/** Says whether any of the files changed since it last looked; a few stats, so cheap per request. */
export function stateWatch(files: readonly string[]): () => boolean {
  const read = () => files.map(signature).join('|')
  let seen = read()
  return () => {
    const now = read()
    const changed = now !== seen
    seen = now
    return changed
  }
}
