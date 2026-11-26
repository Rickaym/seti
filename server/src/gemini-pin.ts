import { geminiPinSchema, type GeminiPin } from './gemini-fetch.js'
import builtIn from './runtimes/gemini/pin.json' with { type: 'json' }

/** The Gemini CLI version Seti installs and runs. */
export const GEMINI_PIN: GeminiPin = geminiPinSchema.parse(builtIn)
