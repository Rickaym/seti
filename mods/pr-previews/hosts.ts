import { SETI_HOST, type OpenPrSummary } from '@seti/mod-api'

const hostLabel = (text: string) => text.toLowerCase().replace(/[^a-z0-9-]+/g, '-')

/** The Seti subdomain a PR's preview is served on, such as `web-pr-7.seti.localhost`. */
export const previewHost = (slug: string, number: number) =>
  `${hostLabel(slug.split('/').at(-1) ?? slug)}-pr-${String(number)}.${SETI_HOST}`

/** The preview origin a Seti subdomain serves; only ever from a Ready comment of the Actions bot. */
export function previewTarget(prs: readonly OpenPrSummary[], hostname: string): string | null {
  const pr = prs.find((candidate) => candidate.preview_host === hostname && candidate.preview.state === 'ready')
  return pr?.preview.url ?? null
}
