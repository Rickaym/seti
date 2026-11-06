import { shortModHash, type ModIcon, type ModInfo, type ModManifest } from '@seti/shared'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { navigate } from '@/lib/route'
import { ModGlyph } from './ModGlyph'
import { CATEGORY_LABELS, publisherOf } from './mod-list'

/** Back to the list of mods, on every screen size: a mod's page sits inside Settings, Mods. */
export function ModsBack() {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="-ml-2 shrink-0"
      aria-label="Back to mods"
      onClick={() => {
        navigate('settings', 'mods')
      }}
    >
      <ArrowLeft />
    </Button>
  )
}

/** A mod's icon, name, publisher and version, as its page and the add preview head them. */
export function ModIdentity({
  icon,
  title,
  publisher,
  version,
  extra,
}: {
  icon: ModIcon | null
  title: string
  publisher: string
  version: string
  extra?: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 py-1">
      <ModGlyph icon={icon} size="lg" />
      <div className="min-w-0 space-y-1">
        <h2 className="truncate text-lg leading-tight font-semibold max-md:text-base">{title}</h2>
        <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span className="wrap-anywhere">{publisher}</span>
          <span className="tabular-nums">{version}</span>
        </p>
        {extra}
      </div>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-0.5 wrap-anywhere">{children}</dd>
    </div>
  )
}

function Links({ manifest }: { manifest: ModManifest }) {
  const links = [
    ['Homepage', manifest.homepage],
    ['Repository', manifest.repository],
  ].filter((link): link is [string, string] => link[1] !== undefined)
  return links.length === 0 ? null : (
    <Fact label="Links">
      <ul className="space-y-1">
        {links.map(([label, url]) => (
          <li key={label}>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
            >
              {label}
              <ExternalLink aria-hidden className="size-3" />
            </a>
          </li>
        ))}
      </ul>
    </Fact>
  )
}

function sourceOf(mod: ModInfo): string {
  const install = mod.install
  if (install === null) {
    return mod.tier === 'third-party' ? 'Loaded by Seti for its tests' : 'Bundled with Seti'
  }
  const track = install.track === null ? '' : ` at ${install.track}`
  return `${install.source_kind === 'dev' ? 'Dev folder ' : ''}${install.source}${track}`
}

/** The facts beside a mod's README: who, what, where it came from, and its links. */
export function ModFacts({ mod }: { mod: ModInfo }) {
  const manifest = mod.manifest
  const categories = (manifest?.categories ?? []).map((category) => CATEGORY_LABELS[category])
  return (
    <dl aria-label="About this mod" className="grid content-start gap-3 text-xs max-md:grid-cols-2">
      <Fact label="Identifier">{mod.id}</Fact>
      <Fact label="Version">{mod.version}</Fact>
      <Fact label="Publisher">
        {publisherOf(mod)}
        {mod.tier === 'third-party' && ' (unverified)'}
      </Fact>
      <Fact label="Source">{sourceOf(mod)}</Fact>
      {mod.install !== null && <Fact label="Hash">{shortModHash(mod.install.hash)}</Fact>}
      {categories.length > 0 && <Fact label="Categories">{categories.join(', ')}</Fact>}
      {manifest?.license !== undefined && <Fact label="License">{manifest.license}</Fact>}
      {manifest !== null && <Fact label="Mod API">{manifest.seti}</Fact>}
      {manifest !== null && <Links manifest={manifest} />}
    </dl>
  )
}
