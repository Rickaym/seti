import {
  DEFAULT_PROFILE_ID,
  PROVIDERS,
  providerOf,
  type GeminiSettings,
  type GeminiSettingsInput,
  type GeminiStatus,
} from '@seti/shared'
import { audit } from './audit.js'
import { redecideWaitingCodexCalls } from './codex-decide.js'
import { refuseAgent } from './ea-guard.js'
import { followGeminiSettings, geminiCopy, installGemini, type GeminiCopy } from './gemini-install.js'
import { GEMINI_PIN } from './gemini-pin.js'
import { HttpError } from './http.js'
import { credentialHasKey, keyedCredentials, keyOutsideDefault } from './provider-key.js'
import { geminiSettings } from './store/gemini-settings.js'

const OFF = 'Gemini is off. The user turns it on in Settings, Runtimes.'
const INSTALLING = 'Gemini CLI is still installing on this Seti; try again in a minute.'
const NO_KEY = "The agent's credential holds no Gemini API key. Add the Gemini API connection to it in Settings."

type Now = { state: 'off' } | GeminiCopy

async function now(settings: GeminiSettings): Promise<Now> {
  return settings.enabled ? geminiCopy() : { state: 'off' }
}

function whyNot(state: Exclude<Now, { state: 'ready' }>): string {
  if (state.state === 'off') {
    return OFF
  }
  return state.state === 'installing'
    ? INSTALLING
    : `Gemini CLI cannot start: ${state.failure.message}. The user retries in Settings, Runtimes.`
}

/** The script Node runs for Gemini CLI, or why no Gemini agent can start now. */
async function entryNow(): Promise<{ entry: string } | { why: string }> {
  const state = await now(await geminiSettings.get())
  return state.state === 'ready' ? { entry: state.entry } : { why: whyNot(state) }
}

/** The script a new Gemini CLI process runs while Gemini is on and installed, else null. */
export async function geminiEntry(): Promise<string | null> {
  const state = await entryNow()
  return 'entry' in state ? state.entry : null
}

/** The script a new Gemini CLI process runs; a runtime that is off or missing starts nothing. */
export async function requireGeminiEntry(): Promise<string> {
  const state = await entryNow()
  if ('why' in state) {
    throw new Error(state.why)
  }
  return state.entry
}

/** Refuses a new Gemini agent while Gemini cannot start one, or on a credential without its key. */
export async function requireGemini(profileId: string): Promise<void> {
  const state = await entryNow()
  if ('why' in state) {
    throw new HttpError(409, state.why)
  }
  if (!(await credentialHasKey(providerOf('gemini'), profileId))) {
    throw new HttpError(409, NO_KEY)
  }
}

/** Where Gemini stands: off, installing, failed with its reason, or with or without its key. */
export async function geminiStatus(): Promise<GeminiStatus> {
  const settings = await geminiSettings.get()
  const state = await now(settings)
  const keyed = await keyedCredentials(providerOf('gemini'))
  const hasKey = keyed.includes(DEFAULT_PROFILE_ID)
  const keyState = hasKey ? 'ready' : 'no_key'
  return {
    state: state.state === 'ready' ? keyState : state.state,
    failure: state.state === 'failed' ? state.failure : null,
    pinned: GEMINI_PIN.version,
    settings,
    keyed,
    keyElsewhere: hasKey ? null : await keyOutsideDefault(providerOf('gemini')),
    pricesAsOf: PROVIDERS.google.prices.asOf,
  }
}

const changedKeys = (before: GeminiSettings, after: GeminiSettings) =>
  (Object.keys(after) as (keyof GeminiSettings)[]).filter((key) => before[key] !== after[key])

/**
 * Changes the Gemini settings as the user, audited with what changed; turning Gemini on installs
 * the pinned Gemini CLI in the background; letting the rules decide answers the calls that wait.
 * The EA and agents are refused.
 */
export async function updateGeminiSettings(input: GeminiSettingsInput): Promise<GeminiStatus> {
  refuseAgent('change the Gemini runtime settings')
  const before = await geminiSettings.get()
  const given = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  const after: GeminiSettings = { ...before, ...given }
  const changed = changedKeys(before, after)
  if (changed.length > 0) {
    await geminiSettings.set(after)
    await audit.record({
      actor: 'user',
      kind: 'system.runtime_changed',
      subject_type: 'system',
      subject_id: 'gemini',
      summary: `Changed the Gemini runtime settings: ${changed.join(', ')}`,
      detail: { runtime: 'gemini', changed, enabled: after.enabled, evaluator_decides: after.evaluator_decides },
    })
    followGeminiSettings(before, after)
    if (!before.evaluator_decides && after.evaluator_decides) {
      await redecideWaitingCodexCalls('gemini')
    }
  }
  return geminiStatus()
}

/** Installs the pinned Gemini CLI again after a failure, as the user; the EA and agents may not. */
export async function retryGemini(): Promise<GeminiStatus> {
  refuseAgent('install the Gemini runtime')
  if ((await geminiSettings.get()).enabled) {
    void installGemini('user')
  }
  return geminiStatus()
}
