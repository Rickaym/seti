import fs from 'node:fs'
import type { CodexFailure, CodexSettings } from '@seti/shared'
import { audit } from './audit.js'
import {
  CodexInstallError,
  fetchPinned,
  holdsSum,
  platformOf,
  programIn,
  stagingDir,
  versionDir,
  type CodexPin,
} from './codex-fetch.js'
import { CODEX_PIN } from './codex-pin.js'
import { CODEX_ROOT } from './config.js'
import { removeOwnedDir } from './owned-dirs.js'
import { codexSettings } from './store/codex-settings.js'

export interface CodexInstallFailure {
  reason: CodexFailure
  message: string
}

/** Where Seti's own copy of a version stands. */
export type CopyState =
  { state: 'ready'; program: string } | { state: 'installing' } | { state: 'failed'; failure: CodexInstallFailure }

const running = new Map<string, Promise<void>>()
const failures = new Map<string, CodexInstallFailure>()
const SWEEP_MS = 60 * 60_000

const failureOf = (e: unknown): CodexInstallFailure =>
  e instanceof CodexInstallError
    ? { reason: e.reason, message: e.message }
    : { reason: 'disk', message: e instanceof Error ? e.message : String(e) }

/** Whether Seti keeps its own copy for these settings: Codex on, with no program of the user's. */
const wantsCopy = (settings: CodexSettings) => settings.enabled && settings.program === null

/** Where Seti's own copy of the pinned version stands. */
export async function copyState(pin: CodexPin = CODEX_PIN): Promise<CopyState> {
  if (running.has(pin.version)) {
    return { state: 'installing' }
  }
  const failed = failures.get(pin.version)
  if (failed !== undefined) {
    return { state: 'failed', failure: failed }
  }
  let sha256: string
  try {
    sha256 = platformOf(pin).sha256
  } catch (e) {
    return { state: 'failed', failure: failureOf(e) }
  }
  const program = programIn(CODEX_ROOT, pin.version)
  if (await holdsSum(program, sha256)) {
    return { state: 'ready', program }
  }
  const failure: CodexInstallFailure = fs.existsSync(program)
    ? { reason: 'checksum', message: `Seti's copy of Codex ${pin.version} changed on disk, so it does not run` }
    : { reason: 'missing', message: `Codex ${pin.version} is not installed yet` }
  return { state: 'failed', failure }
}

/** Removes a folder of Seti's Codex root through the owned-folder checks, or says why not. */
async function discard(dir: string): Promise<void> {
  const refusal = await removeOwnedDir(dir, 'codex', [])
  if (refusal !== null) {
    throw new CodexInstallError('disk', `Could not remove ${dir}: ${refusal}`)
  }
}

async function recordInstall(actor: 'user' | 'system', pin: CodexPin, failure: CodexInstallFailure | null) {
  const build = pin.platforms[`${process.platform}-${process.arch}`]
  const from = build === undefined ? null : new URL(build.tarball).host
  await audit.record({
    actor,
    kind: failure === null ? 'system.runtime_installed' : 'system.runtime_install_failed',
    subject_type: 'system',
    subject_id: 'codex',
    summary:
      failure === null
        ? `Installed Codex ${pin.version} from ${from ?? 'its registry'}, checksums verified`
        : `Could not install Codex ${pin.version}: ${failure.message}`,
    detail:
      failure === null
        ? { runtime: 'codex', version: pin.version, from, sha256: build?.sha256 ?? null }
        : { runtime: 'codex', version: pin.version, from, reason: failure.reason },
  })
}

async function install(actor: 'user' | 'system', pin: CodexPin): Promise<void> {
  try {
    const { fetched } = await fetchPinned({ pin, root: CODEX_ROOT, discard })
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
 * Installs the pinned Codex into Seti's own folder in the background, once however often it is
 * asked; a failure stays as the state until the next try. Only the user turning Codex on or
 * pressing Retry, or Seti's start while Codex is on, calls this.
 */
export async function installCodex(actor: 'user' | 'system', pin: CodexPin = CODEX_PIN): Promise<void> {
  const already = running.get(pin.version)
  if (already !== undefined) {
    return already
  }
  failures.delete(pin.version)
  const run = install(actor, pin).finally(() => {
    running.delete(pin.version)
    sweepQuietly(pin)
  })
  running.set(pin.version, run)
  return run
}

/** The version folders and leftover downloads in the root that the current settings keep. */
function kept(pin: CodexPin, settings: CodexSettings): Set<string> {
  const keep = new Set([...running.keys()].map((version) => stagingDir(CODEX_ROOT, version)))
  if (wantsCopy(settings)) {
    keep.add(versionDir(CODEX_ROOT, pin.version)).add(stagingDir(CODEX_ROOT, pin.version))
  }
  return keep
}

/**
 * Removes the versions and leftover downloads nothing uses any more: all but the pinned version
 * while Codex is on with Seti's copy, all of them otherwise. A folder a running Codex still uses
 * stays until a later sweep finds it free.
 */
export async function sweepCodex(pin: CodexPin = CODEX_PIN): Promise<string[]> {
  const names = await fs.promises.readdir(CODEX_ROOT).catch(() => [])
  const keep = kept(pin, await codexSettings.get())
  const removed: string[] = []
  for (const name of names) {
    const dir = versionDir(CODEX_ROOT, name)
    if (keep.has(dir) || (await removeOwnedDir(dir, 'codex', []).catch(String)) !== null) {
      continue
    }
    removed.push(name)
    if (!name.startsWith('.')) {
      await audit.record({
        actor: 'system',
        kind: 'system.runtime_removed',
        subject_type: 'system',
        subject_id: 'codex',
        summary: `Removed Codex ${name}, which nothing uses any more`,
        detail: { runtime: 'codex', version: name },
      })
    }
  }
  return removed
}

/** A sweep in the background, which only logs a failure. */
const sweepQuietly = (pin: CodexPin = CODEX_PIN) =>
  void sweepCodex(pin).catch((e: unknown) => {
    process.stderr.write(`codex: the sweep failed: ${e instanceof Error ? e.message : String(e)}\n`)
  })

/** After the user changed the settings: install when they now want Seti's copy, else tidy up. */
export async function followSettings(before: CodexSettings, after: CodexSettings): Promise<void> {
  if (wantsCopy(after) && !wantsCopy(before)) {
    void installCodex('user')
  } else if (!wantsCopy(after)) {
    await sweepCodex()
  }
}

/** At start, installs the pinned version when the user has Codex on, then sweeps every hour. */
export function startCodexKeeper(): void {
  void codexSettings
    .get()
    .then((settings) => {
      if (wantsCopy(settings)) {
        void installCodex('system')
      } else {
        sweepQuietly()
      }
    })
    .catch((e: unknown) => {
      process.stderr.write(`codex: could not read the settings: ${e instanceof Error ? e.message : String(e)}\n`)
    })
  setInterval(sweepQuietly, SWEEP_MS).unref()
}
