import type { ModBisectState } from '@seti/shared'
import { audit } from '../audit.js'
import { HttpError } from '../http.js'
import { modHost } from './bundled.js'
import { requireUserConsent } from './consent-guard.js'
import { isRequired } from './host.js'
import { modBisectRows, type BisectRow } from '../store/mod-lifecycle.js'

const stateOf = (row: BisectRow): ModBisectState => ({
  step: row.step,
  suspects: row.suspects,
  culprit: row.suspects.length === 1 ? (row.suspects[0] ?? null) : null,
  started_at: row.started_at,
})

export async function bisectState(): Promise<ModBisectState | null> {
  const row = await modBisectRows.get()
  return row === null ? null : stateOf(row)
}

/** Turns each mod on or off as wanted; a mod that has gone or cannot start is left as it is. */
async function apply(wanted: ReadonlyMap<string, boolean>): Promise<void> {
  for (const [id, on] of wanted) {
    const mod = modHost.get(id)
    if (mod !== undefined && mod.enabled !== on && mod.problem === null) {
      await modHost.setEnabled(id, on).catch((e: unknown) => {
        process.stderr.write(`mods: bisect left ${id} as it was: ${e instanceof Error ? e.message : String(e)}\n`)
      })
    }
  }
}

/** Every suspect on as before except the half under test, which is off. */
async function runStep(row: BisectRow): Promise<BisectRow> {
  const off = row.suspects.length === 1 ? row.suspects : row.suspects.slice(0, Math.ceil(row.suspects.length / 2))
  const wanted = new Map(Object.entries(row.original))
  for (const id of off) {
    wanted.set(id, false)
  }
  await apply(wanted)
  const next = { ...row, off, step: row.step + 1 }
  await modBisectRows.put(next)
  await audit.record({
    actor: 'user',
    kind: 'mod.bisect_step',
    subject_type: 'mod',
    summary:
      row.suspects.length === 1
        ? `Mod bisect: ${row.suspects[0] ?? ''} looks like the cause`
        : `Mod bisect step ${String(next.step)}: turned off ${off.join(', ')}`,
    detail: { step: next.step, off, suspects: row.suspects },
  })
  return next
}

/** Starts a bisect over every mod that is on, bar required ones; only the user runs it. */
export async function startBisect(): Promise<ModBisectState> {
  await requireUserConsent({ stepUp: false })
  if ((await modBisectRows.get()) !== null) {
    throw new HttpError(409, 'A mod bisect is running; answer it or cancel it first')
  }
  const on = modHost
    .list()
    .filter((mod) => mod.tier !== 'theme' && mod.enabled && mod.manifest !== null && !isRequired(mod))
  const original = Object.fromEntries(on.map((mod) => [mod.manifest?.id ?? '', true]))
  const suspects = Object.keys(original)
  if (suspects.length === 0) {
    throw new HttpError(409, 'No mod is on, so no mod can be the cause')
  }
  return stateOf(await runStep({ original, suspects, off: [], step: 0, started_at: new Date().toISOString() }))
}

/** Narrows the suspects: a problem still there clears the half that was off, gone convicts it. */
export async function answerBisect(broken: boolean): Promise<ModBisectState> {
  await requireUserConsent({ stepUp: false })
  const row = await modBisectRows.get()
  if (row === null) {
    throw new HttpError(409, 'No mod bisect is running')
  }
  if (row.suspects.length === 1) {
    throw new HttpError(409, 'The bisect found its mod; keep it off or turn it back on')
  }
  const suspects = broken ? row.suspects.filter((id) => !row.off.includes(id)) : row.off
  return stateOf(await runStep({ ...row, suspects }))
}

/** Ends the bisect, restoring every mod; keepOff leaves the mod it found off. */
export async function endBisect(keepOff: boolean): Promise<void> {
  await requireUserConsent({ stepUp: false })
  const row = await modBisectRows.get()
  if (row === null) {
    return
  }
  const wanted = new Map(Object.entries(row.original))
  const culprit = row.suspects.length === 1 ? row.suspects[0] : undefined
  if (keepOff && culprit !== undefined) {
    wanted.set(culprit, false)
  }
  await apply(wanted)
  await modBisectRows.clear()
  await audit.record({
    actor: 'user',
    kind: 'mod.bisect_step',
    subject_type: 'mod',
    summary: keepOff && culprit !== undefined ? `Ended the mod bisect with ${culprit} off` : 'Ended the mod bisect',
    detail: { ended: true, kept_off: keepOff && culprit !== undefined ? culprit : null },
  })
}
