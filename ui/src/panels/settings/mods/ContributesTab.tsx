import type { ModManifest } from '@seti/shared'
import { contributionGroups } from './mod-contributes'

/** What the mod adds to Seti, group by group, as its manifest declares it. */
export function ContributesTab({ manifest }: { manifest: ModManifest | null }) {
  const groups = manifest === null ? [] : contributionGroups(manifest.contributes)
  if (groups.length === 0) {
    return <p className="text-muted-foreground">It adds nothing beyond its settings.</p>
  }
  return (
    <div className="grid max-w-[72ch] gap-5">
      {groups.map((group) => (
        <section key={group.title} aria-label={group.title} className="space-y-1.5">
          <h3 className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">{group.title}</h3>
          <ul className="border border-border bg-card">
            {group.items.map((item) => (
              <li key={item.name} className="border-b border-border px-3 py-2 last:border-b-0">
                <div className="text-sm font-medium wrap-anywhere">{item.name}</div>
                {item.detail !== null && <div className="mt-0.5 text-muted-foreground">{item.detail}</div>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
