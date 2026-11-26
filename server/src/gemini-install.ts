import fs from 'node:fs'
import type { GeminiSettings, InstallFailure } from '@seti/shared'
import { audit } from './audit.js'
import { GEMINI_ROOT } from './config.js'
import { entryIn, fetchGemini, holdsBundle, versionDir, type GeminiPin } from './gemini-fetch.js'
import { GEMINI_PIN } from './gemini-pin.js'
import { removeOwnedDir } from './owned-dirs.js'
import { InstallError } from './pinned-download.js'
import { geminiSettings } from './store/gemini-settings.js'

interface GeminiInstallFailure {
  reason: InstallFailure
  message: string
}

/** Where Seti's own copy of the pinned Gemini CLI stands. */
export type GeminiCopy =
  { state: 'ready'; entry: string } | { state: 'installing' } | { state: 'failed'; failure: GeminiInstallFailure }

const running = new Map<string, Promise<void>>()
const failures = new Map<string, GeminiInstallFailure>()

const failureOf = (e: unknown): GeminiInstallFailure =>
  e instanceof InstallError
    ? { reason: e.reason, message: e.message }
    : { reason: 'disk', message: e instanceof Error ? e.message : String(e) }

/** Where Seti's copy of the pinned version stands: checked on disk, installing, or failed. */
export async function geminiCopy(pin: GeminiPin = GEMINI_PIN): Promise<GeminiCopy> {
  if (running.has(pin.version)) {
    return { state: 'installing' }
  }
  const failed = failures.get(pin.version)
  if (failed !== undefined) {
    return { state: 'failed', failure: failed }
  }
  if (await holdsBundle(GEMINI_ROOT, pin)) {
    return { state: 'ready', entry: entryIn(GEMINI_ROOT, pin.version) }
  }
  return { state: 'failed', failure: { reason: 'missing', message: `Gemini CLI ${pin.version} is not installed yet` } }
}

async function discard(dir: string): Promise<void> {
  const refusal = await removeOwnedDir(dir, 'gemini', [])
  if (refusal !== null) {
    throw new InstallError('disk', `Could not remove ${dir}: ${refusal}`)
  }
}

async function recordInstall(actor: 'user' | 'system', pin: GeminiPin, failure: GeminiInstallFailure | null) {
  const from = new URL(pin.tarball).host
  await audit.record({
    actor,
    kind: failure === null ? 'system.runtime_installed' : 'system.runtime_install_failed',
    subject_type: 'system',
    subject_id: 'gemini',
    summary:
      failure === null
        ? `Installed Gemini CLI ${pin.version} from ${from}, checksums verified`
        : `Could not install Gemini CLI ${pin.version}: ${failure.message}`,
    detail:
      failure === null
        ? { runtime: 'gemini', version: pin.version, from, sha256: pin.bundle }
        : { runtime: 'gemini', version: pin.version, from, reason: failure.reason },
  })
}

async function install(actor: 'user' | 'system', pin: GeminiPin): Promise<void> {
  try {
    const { fetched } = await fetchGemini({ pin, root: GEMINI_ROOT, discard })
    if (fetched) {
      await recordInstall(actor, pin, null)
    }
  } catch (e) {
    const failure = failureOf(e)
    failures.set(pin.version, failure)
    await recordInstall(actor, pin, failure)
  }
}

/**
 * Installs the pinned Gemini CLI into Seti's own folder in the background, once however often it
 * is asked; a failure stays as the state until the next try. Only the user turning Gemini on or
 * pressing Retry, or Seti's start while Gemini is on, calls this.
 */
export async function installGemini(actor: 'user' | 'system', pin: GeminiPin = GEMINI_PIN): Promise<void> {
  const already = running.get(pin.version)
  if (already !== undefined) {
    return already
  }
  failures.delete(pin.version)
  const run = install(actor, pin).finally(() => running.delete(pin.version))
  running.set(pin.version, run)
  return run
}

/**
 * While Gemini is off and nothing installs, removes every folder of Seti's Gemini root; a folder
 * a running Gemini CLI still uses stays until a later sweep finds it free.
 */
async function sweepGemini(): Promise<void> {
  if (running.size > 0 || (await geminiSettings.get()).enabled) {
    return
  }
  for (const name of await fs.promises.readdir(GEMINI_ROOT).catch(() => [])) {
    if ((await removeOwnedDir(versionDir(GEMINI_ROOT, name), 'gemini', []).catch(String)) !== null) {
      continue
    }
    if (!name.startsWith('.')) {
      await audit.record({
        actor: 'system',
        kind: 'system.runtime_removed',
        subject_type: 'system',
        subject_id: 'gemini',
        summary: `Removed Gemini CLI ${name}, which nothing uses any more`,
        detail: { runtime: 'gemini', version: name },
      })
    }
  }
}

const sweepQuietly = () =>
  void sweepGemini().catch((e: unknown) => {
    process.stderr.write(`gemini: the sweep failed: ${e instanceof Error ? e.message : String(e)}\n`)
  })

/** After the user changed the settings: installs when they turned Gemini on, tidies up when off. */
export async function followGeminiSettings(before: GeminiSettings, after: GeminiSettings): Promise<void> {
  if (after.enabled && !before.enabled) {
    void installGemini('user')
  } else if (!after.enabled) {
    await sweepGemini()
  }
}

/** At start, installs the pinned version when the user has Gemini on, and else tidies up. */
export function startGeminiKeeper(): void {
  void geminiSettings
    .get()
    .then((settings) => {
      if (settings.enabled) {
        void installGemini('system')
      } else {
        sweepQuietly()
      }
    })
    .catch((e: unknown) => {
      process.stderr.write(`gemini: could not read the settings: ${e instanceof Error ? e.message : String(e)}\n`)
    })
}
