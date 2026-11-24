import fs from 'node:fs'
import path from 'node:path'
import type { ClaudeStatus } from '@seti/shared'
import { claudeCredentialMode } from './claude-credential.js'
import { CLAUDE_BIN, CLAUDE_HOME } from './config.js'
import { programVersion } from './program-version.js'

const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** The model and effort the user's Claude Code settings name, which agents without a pick run on. */
export function claudeDefaults(file = path.join(CLAUDE_HOME, 'settings.json')) {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { default_model: null, default_effort: null }
  }
  const settings = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  return { default_model: text(settings.model), default_effort: text(settings.effortLevel) }
}

/** Claude Code as Settings shows it: the program, its version, its defaults and the sign-in kind. */
export const claudeStatus = async (): Promise<ClaudeStatus> => ({
  program: CLAUDE_BIN,
  version: await programVersion(CLAUDE_BIN),
  ...claudeDefaults(),
  sign_in: await claudeCredentialMode(),
})
