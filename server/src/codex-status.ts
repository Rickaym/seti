import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import {
  DEFAULT_PROFILE_ID,
  type CodexSettings,
  type CodexSettingsInput,
  type CodexStatus,
  type StoredRuntime,
} from '@seti/shared'
import { audit } from './audit.js'
import { codexKeyedCredentials, credentialHasKey } from './codex-key.js'
import { refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import pin from './runtimes/codex/pin.json' with { type: 'json' }
import { PRICES_AS_OF } from './runtimes/codex/prices.js'
import { codexSettings } from './store/codex-settings.js'

const run = promisify(execFile)

/** The Codex version this Seti is built and tested against. */
const PINNED = pin.version

/** The last version read, by program and the file's change time, so a check runs once per file. */
let known: { key: string; version: string | null } | null = null

/** The version the program reports, or null when it is not there or does not run. */
async function versionOf(program: string): Promise<string | null> {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(program)
  } catch {
    return null
  }
  const key = `${program}:${String(stat.mtimeMs)}:${String(stat.size)}`
  if (known?.key !== key) {
    const { stdout } = await run(program, ['--version'], { timeout: 10_000 }).catch(() => ({ stdout: '' }))
    const word = stdout.trim().split(' ').at(-1) ?? ''
    known = { key, version: word === '' ? null : word }
  }
  return known.version
}

/** The states the settings and program decide, before any key counts. */
type ProgramState = Exclude<CodexStatus['state'], 'ready' | 'no_key'>

/** Where the program leaves Codex, or null when it can run. */
function programState(settings: CodexSettings, version: string | null): ProgramState | null {
  if (!settings.enabled) {
    return 'off'
  }
  if (settings.program === null) {
    return 'not_set_up'
  }
  if (version === null) {
    return 'missing'
  }
  return version === PINNED ? null : 'update_needed'
}

/** The settings, the version the program reports and the state they leave Codex in. */
async function programNow() {
  const settings = await codexSettings.get()
  const version = settings.program === null ? null : await versionOf(settings.program)
  return { settings, version, state: programState(settings, version) }
}

/**
 * Where Codex stands: off, not set up, missing, an older or newer version, or whether the default
 * credential, which new agents from the start page get, holds an OpenAI key.
 */
export async function codexStatus(): Promise<CodexStatus> {
  const { settings, version, state } = await programNow()
  const keyed = await codexKeyedCredentials()
  const ready = keyed.includes(DEFAULT_PROFILE_ID) ? 'ready' : 'no_key'
  return { state: state ?? ready, version, pinned: PINNED, settings, keyed, pricesAsOf: PRICES_AS_OF }
}

const NO_KEY =
  "The agent's credential has no OpenAI key: the user adds a connection with a header on api.openai.com to it in Connections"

const WHY: Record<ProgramState, string> = {
  off: 'Codex is off on this Seti; the user turns it on in Settings, Runtimes',
  not_set_up: 'Codex has no program named; the user names it in Settings, Runtimes',
  missing: 'The codex program named in Settings, Runtimes is not there or does not run',
  update_needed: 'The codex program named in Settings, Runtimes is not the version this Seti needs',
}

/** Refuses a new agent on a runtime that cannot start one now, or on a credential without its key. */
export async function requireRuntime(runtime: StoredRuntime, profileId: string): Promise<void> {
  if (runtime !== 'codex') {
    return
  }
  const { state } = await programNow()
  if (state !== null) {
    throw new HttpError(409, WHY[state])
  }
  if (!(await credentialHasKey(profileId))) {
    throw new HttpError(409, NO_KEY)
  }
}

/** The names of the settings a change touched, for the audit record. */
const changedKeys = (before: CodexSettings, after: CodexSettings) =>
  (Object.keys(after) as (keyof CodexSettings)[]).filter((key) => before[key] !== after[key])

/**
 * Changes the Codex settings as the user, audited with what changed. The EA and agents are
 * refused: the settings decide whether agents run on another vendor's model and who answers
 * their calls.
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
  }
  return codexStatus()
}
