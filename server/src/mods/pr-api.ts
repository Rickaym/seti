import type { HostResolver, ServerModApi } from '@seti/mod-api'
import { modScoped, type ModManifest } from '@seti/shared'
import { prDecorators } from '../pr-decorators.js'
import { cachedOpenPrs } from '../prs.js'
import { hostProxies } from '../subdomain-proxy.js'
import type { ApiTarget } from './api.js'

function declared(entries: readonly { id: string }[], id: string, manifest: ModManifest, what: string): void {
  if (!entries.some((entry) => entry.id === id)) {
    throw new Error(`${manifest.id} registers the ${what} ${id}, which its manifest does not declare`)
  }
}

/** Seti's open PRs, for a mod that declares a PR decorator; a bundled-only point. */
export function prsApi(target: ApiTarget): ServerModApi['prs'] {
  const { manifest } = target
  return {
    decorate: (id, decorate) => {
      declared(manifest.contributes.prDecorators, id, manifest, 'PR decorator')
      return target.track(prDecorators.register({ key: modScoped(manifest.id, id), decorate }))
    },
    open: async () => {
      if (manifest.contributes.prDecorators.length === 0) {
        throw new Error(`${manifest.id} reads open PRs without declaring a PR decorator`)
      }
      return (await cachedOpenPrs()).map(({ repo_slug, number, url, preview, preview_host }) => ({
        repo_slug,
        number,
        url,
        preview,
        preview_host,
      }))
    },
  }
}

/** Only an HTTPS origin; anything else the resolver gives serves nothing. */
function httpsOrigin(value: string | null): URL | null {
  if (value === null || !URL.canParse(value)) {
    return null
  }
  const url = new URL(value)
  return url.protocol === 'https:' && url.origin === value ? url : null
}

/** Serves Seti subdomains from the HTTPS origin the mod resolves; a bundled-only point. */
export function hostProxyApi(target: ApiTarget): ServerModApi['registerHostProxy'] {
  const { manifest } = target
  return (id, resolve: HostResolver) => {
    declared(manifest.contributes.hostProxies, id, manifest, 'host proxy')
    const key = modScoped(manifest.id, id)
    const checked = async (host: string) => httpsOrigin(await resolve(host).catch(() => null))
    return target.track(hostProxies.register({ key, resolve: checked }))
  }
}
