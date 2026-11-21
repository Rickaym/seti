import { fileUrlTarget, SHARE_PREFIX, type ServiceIconKey } from '@seti/shared'
import { clip, LINK_SERVICES, shortPath, type LinkGlyph, type LinkService } from './link-services'

/** What a link pill shows for a URL. */
export interface LinkLabel {
  label: string
  /** The service it points to, such as slack or github; `seti` for Seti's own, `web` otherwise. */
  service: string
  icon: ServiceIconKey | null
  glyph: LinkGlyph
  /** The agent a Seti link opens, so the pill can show its name. */
  agent?: string
}

const WEB_PROTOCOLS = new Set(['http:', 'https:'])
const MAX_URL = 8192

/** Decoded path segments; a segment that does not decode stays as written. */
function segments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        return part
      }
    })
}

const servesHost = (service: LinkService, host: string) =>
  service.hosts.some((name) => (name.startsWith('*.') ? host.endsWith(name.slice(1)) : host === name))

function serviceLabel(url: URL, parts: readonly string[]): LinkLabel | null {
  for (const service of LINK_SERVICES) {
    if (!servesHost(service, url.hostname) || service.path?.test(url.pathname) === false) {
      continue
    }
    const label = service.label(url, parts)
    return label === null ? null : { label, service: service.id, icon: service.icon, glyph: service.glyph }
  }
  return null
}

const AGENT_HASH = /^#\/?agents\/([\w-]+)\/?$/

/** A link to this Seti: an agent, a file, a share or a page. */
function setiLabel(url: URL, href: string, parts: readonly string[]): LinkLabel {
  const seti = { service: 'seti', icon: null }
  const file = fileUrlTarget(href)
  if (file !== null) {
    return { ...seti, label: clip(file.path.split('/').at(-1) ?? file.path), glyph: 'file' }
  }
  if (url.pathname.startsWith(SHARE_PREFIX)) {
    return { ...seti, label: 'Shared file', glyph: 'share' }
  }
  const agent = AGENT_HASH.exec(url.hash)?.[1]
  if (agent !== undefined) {
    return { ...seti, label: 'Agent', glyph: 'agent', agent }
  }
  const section = url.hash.replace(/^#\/?/, '').split('/')[0] ?? ''
  const page = section === '' ? shortPath(parts) : section
  return { ...seti, label: page === '' ? 'Seti' : `Seti ${clip(page)}`, glyph: 'settings' }
}

function webLabel(url: URL, parts: readonly string[]): LinkLabel {
  const host = url.host.replace(/^www\./, '')
  const label = parts.length === 0 ? host : `${host}/${shortPath(parts)}`
  return { label, service: 'web', icon: null, glyph: 'link' }
}

/**
 * The pill for an http or https URL, from the URL alone: nothing is fetched. Null for any other
 * scheme or a URL that does not parse. Links on `origin`, this Seti's, name agents and files.
 */
export function linkLabel(href: string, origin?: string): LinkLabel | null {
  if (href.length > MAX_URL || !URL.canParse(href)) {
    return null
  }
  const url = new URL(href)
  if (!WEB_PROTOCOLS.has(url.protocol)) {
    return null
  }
  const parts = segments(url.pathname)
  if (url.origin === origin) {
    return setiLabel(url, href, parts)
  }
  return serviceLabel(url, parts) ?? webLabel(url, parts)
}

/** This Seti's origin, whose links name agents and files; none outside a browser. */
const ownOrigin = () => (typeof window === 'undefined' ? undefined : window.location.origin)

/** What a pill for this URL shows, or null when it is not an http or https URL. */
export const pillOf = (href: string | undefined): LinkLabel | null =>
  href === undefined ? null : linkLabel(href, ownOrigin())
