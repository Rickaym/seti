import {
  DEFAULT_PROFILE_ID,
  type CodexSettings,
  type CodexSettingsInput,
  type CodexStatus,
  type StoredRuntime,
} from '@seti/shared'
import { audit } from './audit.js'
import { redecideWaitingCodexCalls } from './codex-decide.js'
import { copyState, followSettings, installCodex, type CodexInstallFailure } from './codex-install.js'
import { codexKeyedCredentials, credentialHasKey, keyOutsideDefault } from './codex-key.js'
import { CODEX_PIN } from './codex-pin.js'
import { refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { forgetVersions, programVersion } from './program-version.js'
import { PRICES_AS_OF } from './runtimes/codex/prices.js'
import { codexSettings } from './store/codex-settings.js'

/** The Codex version this Seti is built and tested against. */
const PINNED = CODEX_PIN.version

/** Where the program agents start leaves Codex, before any key counts. */
type ProgramNow =
  | { state: 'off' | 'installing'; version: null; program: null }
  | { state: 'failed'; version: string | null; program: null; failure: CodexInstallFailure }
  | { state: 'runs'; version: string; program: string }

/** The program the user named in place of Seti's copy, checked to report the pinned version. */
async function ownProgram(program: string): Promise<ProgramNow> {
  const version = await programVersion(program)
  if (version === PINNED) {
    return { state: 'runs', version, program }
  }
  const message =
    version === null
      ? `The program you named, ${program}, is not there or does not run`
      : `The program you named reports ${version}; this Seti needs ${PINNED}`
  return { state: 'failed', version, program: null, failure: { reason: 'program', message } }
}

/** The program new Codex agents start and where it stands, from the settings. */
async function programNow(settings: CodexSettings): Promise<ProgramNow> {
  if (!settings.enabled) {
    return { state: 'off', version: null, program: null }
  }
  if (settings.program !== null) {
    return ownProgram(settings.program)
  }
  const copy = await copyState()
  if (copy.state === 'ready') {
    return { state: 'runs', version: PINNED, program: copy.program }
  }
  return copy.state === 'installing'
    ? { state: 'installing', version: null, program: null }
    : { state: 'failed', version: null, program: null, failure: copy.failure }
}

/** The program a new Codex process starts, or null while Codex is off, installing or failed. */
export async function codexProgram(): Promise<string | null> {
  return (await programNow(await codexSettings.get())).program
}

/**
 * Where Codex stands: off, installing, failed with its reason, or whether the default credential,
 * which new agents from the start page get, holds an OpenAI key.
 */
export async function codexStatus(): Promise<CodexStatus> {
  const settings = await codexSettings.get()
  const now = await programNow(settings)
  const keyed = await codexKeyedCredentials()
  const ready = keyed.includes(DEFAULT_PROFILE_ID) ? 'ready' : 'no_key'
  return {
    state: now.state === 'runs' ? ready : now.state,
    failure: now.state === 'failed' ? now.failure : null,
    version: now.version,
    pinned: PINNED,
    binary: now.program,
    settings,
    keyed,
    keyElsewhere: keyed.includes(DEFAULT_PROFILE_ID) ? null : await keyOutsideDefault(),
    pricesAsOf: PRICES_AS_OF,
  }
}

const NO_KEY =
  "The agent's credential has no OpenAI key: the user adds a connection with a header on api.openai.com to it in Connections"

/** Why a new Codex agent cannot start now, as the agent and the user read it. */
function whyNot(now: Exclude<ProgramNow, { state: 'runs' }>): string {
  if (now.state === 'off') {
    return 'Codex is off on this Seti; the user turns it on in Settings, Runtimes'
  }
  return now.state === 'failed'
    ? `Codex cannot start: ${now.failure.message}. The user retries in Settings, Runtimes`
    : 'Codex is still installing on this Seti; try again in a minute'
}

/** The program a Codex agent's process starts, or a refusal saying why there is none. */
export async function requireCodexProgram(settings: CodexSettings): Promise<string> {
  const now = await programNow(settings)
  if (now.state !== 'runs') {
    throw new Error(whyNot(now))
  }
  return now.program
}

/** The program a new process of the runtime starts where Seti installs it, else null. */
export const runtimeProgram = async (runtime: StoredRuntime): Promise<string | null> =>
  runtime === 'codex' ? codexProgram() : Promise.resolve(null)

/** Refuses a new agent on a runtime that cannot start one now, or on a credential without its key. */
export async function requireRuntime(runtime: StoredRuntime, profileId: string): Promise<void> {
  if (runtime !== 'codex') {
    return
  }
  const now = await programNow(await codexSettings.get())
  if (now.state !== 'runs') {
    throw new HttpError(409, whyNot(now))
  }
  if (!(await credentialHasKey(profileId))) {
    throw new HttpError(409, NO_KEY)
  }
}

/** The names of the settings a change touched, for the audit record. */
const changedKeys = (before: CodexSettings, after: CodexSettings) =>
  (Object.keys(after) as (keyof CodexSettings)[]).filter((key) => before[key] !== after[key])

/**
 * Changes the Codex settings as the user, audited with what changed; turning Codex on installs
 * the pinned version in the background; letting the rules decide answers the calls that wait.
 * The EA and agents are refused: the settings decide whether agents run on another vendor's
 * model and who answers their calls.
 */
export async function updateCodexSettings(input: CodexSettingsInput): Promise<CodexStatus> {
  refuseAgent('change the Codex runtime settings')
  const before = await codexSettings.get()
  const given = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  const after: CodexSettings = { ...before, ...given }
  const changed = changedKeys(before, after)
  if (changed.length > 0) {
    await codexSettings.set(after)
    await audit.record({
      actor: 'user',
      kind: 'system.runtime_changed',
      subject_type: 'system',
      subject_id: 'codex',
      summary: `Changed the Codex runtime settings: ${changed.join(', ')}`,
      detail: { runtime: 'codex', changed, enabled: after.enabled, evaluator_decides: after.evaluator_decides },
    })
    await followSettings(before, after)
    if (!before.evaluator_decides && after.evaluator_decides) {
      await redecideWaitingCodexCalls()
    }
  }
  return codexStatus()
}

/**
 * Tries again after a failure, as the user: installs the pinned version again, or reads the
 * version of the program the user named afresh. The EA and agents are refused, as for a change.
 */
export async function retryCodex(): Promise<CodexStatus> {
  refuseAgent('install the Codex runtime')
  const settings = await codexSettings.get()
  forgetVersions()
  if (settings.enabled && settings.program === null) {
    void installCodex('user')
  }
  return codexStatus()
}
