import fs from 'node:fs'
import { GEMINI_PIN_FILE } from './config.js'
import { geminiPinSchema, type GeminiPin } from './gemini-fetch.js'
import builtIn from './runtimes/gemini/pin.json' with { type: 'json' }

/** The Gemini CLI Seti installs: its own pin, or in a test run one naming a registry here. */
export const GEMINI_PIN: GeminiPin = geminiPinSchema.parse(
  GEMINI_PIN_FILE === '' ? builtIn : JSON.parse(fs.readFileSync(GEMINI_PIN_FILE, 'utf8')),
)
