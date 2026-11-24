import fs from 'node:fs'
import { codexPinSchema, type CodexPin } from './codex-fetch.js'
import { CODEX_PIN_FILE } from './config.js'
import builtIn from './runtimes/codex/pin.json' with { type: 'json' }

/** The pin Seti installs from: its own, or in a test run one naming a registry on this machine. */
export const CODEX_PIN: CodexPin = codexPinSchema.parse(
  CODEX_PIN_FILE === '' ? builtIn : JSON.parse(fs.readFileSync(CODEX_PIN_FILE, 'utf8')),
)
