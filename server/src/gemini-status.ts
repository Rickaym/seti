import { providerOf } from '@seti/shared'
import { GEMINI_ROOT } from './config.js'
import { entryIn, holdsBundle } from './gemini-fetch.js'
import { GEMINI_PIN } from './gemini-pin.js'
import { HttpError } from './http.js'
import { credentialHasKey } from './provider-key.js'
import { geminiSettings } from './store/gemini-settings.js'

const OFF = 'Gemini is off. The user turns it on in Settings, Runtimes.'
const MISSING = "Seti's copy of Gemini CLI is not installed. Settings, Runtimes installs it when Gemini is on."
const NO_KEY = "The agent's credential holds no Gemini API key. Add the Gemini API connection to it in Settings."

/** The script Node runs for Gemini CLI, or why no Gemini agent can start now. */
async function entryNow(): Promise<{ entry: string } | { why: string }> {
  if (!(await geminiSettings.get()).enabled) {
    return { why: OFF }
  }
  if (!(await holdsBundle(GEMINI_ROOT, GEMINI_PIN))) {
    return { why: MISSING }
  }
  return { entry: entryIn(GEMINI_ROOT, GEMINI_PIN.version) }
}

/** The script a new Gemini CLI process runs while Gemini is on and installed, else null. */
export async function geminiEntry(): Promise<string | null> {
  const now = await entryNow()
  return 'entry' in now ? now.entry : null
}

/** The script a new Gemini CLI process runs; a runtime that is off or missing starts nothing. */
export async function requireGeminiEntry(): Promise<string> {
  const now = await entryNow()
  if ('why' in now) {
    throw new Error(now.why)
  }
  return now.entry
}

/** Refuses a new Gemini agent while Gemini cannot start one, or on a credential without its key. */
export async function requireGemini(profileId: string): Promise<void> {
  const now = await entryNow()
  if ('why' in now) {
    throw new HttpError(409, now.why)
  }
  if (!(await credentialHasKey(providerOf('gemini'), profileId))) {
    throw new HttpError(409, NO_KEY)
  }
}
