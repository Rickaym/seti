import fs from 'node:fs'
import path from 'node:path'
import { SETI_HOME } from './config.js'
import { TOOL_OOM_ADJ } from './oom-guard.js'

/**
 * Claude Code runs each Bash tool command, hook and stdio MCP server as `<prefix> '<command>'`.
 * This prefix raises its own oom_score_adj before it runs the command, so a tool is the kernel's
 * first pick from its first page, and runs it in the shell Claude Code would: CLAUDE_CODE_SHELL,
 * then SHELL, when bash or zsh, else bash.
 */
const TOOL_SHELL = `#!/bin/sh
echo ${String(TOOL_OOM_ADJ)} >/proc/self/oom_score_adj 2>/dev/null
for shell in "\${CLAUDE_CODE_SHELL:-}" "\${SHELL:-}" /bin/bash; do
  case $shell in *bash* | *zsh*) [ -x "$shell" ] && break ;; esac
done
exec "$shell" -c "$1"
`

const readText = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Writes the prefix to `file` unless it is current, by rename so no command reads half of it. */
export function writeToolShell(file: string): string {
  if (readText(file) !== TOOL_SHELL) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${String(process.pid)}.tmp`
    fs.writeFileSync(temp, TOOL_SHELL, { mode: 0o755 })
    fs.renameSync(temp, file)
  }
  return file
}

let hostShell: string | null = null

/** The prefix for agents that run on the host, written once per server. */
export function hostToolShell(): string {
  hostShell ??= writeToolShell(path.join(SETI_HOME, 'bin', 'tool-shell'))
  return hostShell
}

/** Makes Claude Code start its commands, hooks and MCP servers through the prefix at `file`. */
export const toolShellEnv = (file: string) => ({ CLAUDE_CODE_SHELL_PREFIX: file })
