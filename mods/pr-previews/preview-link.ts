import { SETI_HOSTNAMES, type PullRequest } from '@seti/mod-api'

function proxiedOrigin(host: string): string {
  const url = new URL(window.location.origin)
  url.hostname = host
  return url.origin
}

/** Preview hosts are loopback names that a browser on the public hostname cannot reach. */
const onPublicHost = () => !SETI_HOSTNAMES.has(window.location.hostname)

/** Where a ready preview opens: Seti's preview host on loopback, else the posted deployment. */
export function previewLink(pr: Pick<PullRequest, 'preview' | 'preview_host'>): string | null {
  if (pr.preview.state !== 'ready') {
    return null
  }
  return pr.preview_host === null || onPublicHost() ? pr.preview.url : `${proxiedOrigin(pr.preview_host)}/`
}
