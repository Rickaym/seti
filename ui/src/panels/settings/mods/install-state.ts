import type { ModConsentLine, ModInstallInfo } from '@seti/shared'

export type Bindings = Readonly<Record<string, string>>

export const kb = (bytes: number) => `${String(Math.max(1, Math.round(bytes / 1024)))} KB`

/** Every connection capability has a connection picked. */
export const allBound = (lines: readonly ModConsentLine[], bindings: Bindings) =>
  lines.every((line) => line.capability.name !== 'connection' || (bindings[line.capability.variable] ?? '') !== '')

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** A short note for the mod's row: the update that waits, and why. */
export function pendingNote(install: ModInstallInfo): string | null {
  const pending = install.pending
  if (pending === null) {
    return null
  }
  const older = pending.older ? ' (an older version)' : ''
  return pending.applies_at === null
    ? `${pending.version}${older} asks for more and waits for you.`
    : `Updates to ${pending.version}${older} on ${when(pending.applies_at)}.`
}
