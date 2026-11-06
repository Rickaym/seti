import { consentLines, consentWarnings, type ModInfo } from '@seti/shared'
import { ShieldCheck, TriangleAlert } from 'lucide-react'
import { ConsentLine } from './ConsentView'

function grantLine(mod: ModInfo): string {
  if (mod.tier === 'third-party') {
    return mod.enabled
      ? 'You granted these when you installed it. Seti enforces each one on its server.'
      : 'You granted these when you installed it; it uses none of them while it is off.'
  }
  return mod.enabled
    ? 'It holds these while it is on. Seti enforces each one on its server.'
    : 'It gets these when you turn it on.'
}

/** What the mod may do, in Seti's words, with what is granted now and the warnings that apply. */
export function PermissionsTab({ mod, isolated }: { mod: ModInfo; isolated: boolean }) {
  const manifest = mod.manifest
  if (manifest === null) {
    return <p className="text-muted-foreground">Seti could not read what this mod asks for.</p>
  }
  const lines = consentLines(manifest, () => null)
  const warnings = mod.tier === 'third-party' ? consentWarnings(manifest, isolated) : []
  return (
    <div className="max-w-[72ch] space-y-4 text-sm">
      {lines.length === 0 ? (
        <p>It asks for no permissions: it can only show its settings and what it adds to Seti.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-muted-foreground">{grantLine(mod)}</p>
          <ul aria-label={`What ${mod.name} may do`} className="space-y-3">
            {lines.map((line) => (
              <ConsentLine key={line.capability.name} line={line} />
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <ul aria-label="Warnings" className="space-y-2">
          {warnings.map((warning) => (
            <li key={warning} className="flex gap-2">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}
      {mod.security_sensitive && (
        <p className="flex gap-2">
          <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>Only you turn it on or off; the EA and agents cannot.</span>
        </p>
      )}
    </div>
  )
}
