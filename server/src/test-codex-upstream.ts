import type { Upstream } from './egress-proxy.js'

/** The only host a Codex agent's proxy may reach. */
export const MODEL_HOST = 'api.openai.com'

/** What a proxy did with a host: dialled it through the upstream, or refused it. */
export type EgressNote = (kind: 'dialled' | 'refused', host: string) => void

/**
 * Where a test's proxies send their traffic: the model host to the local HTTPS front on `port`,
 * trusted by `caPem`, and nothing else; each host they dial or refuse is noted.
 */
export function modelUpstream(port: number, caPem: string, note: EgressNote, modelHost = MODEL_HOST) {
  const upstream: Upstream = {
    address: async (host) => {
      note('dialled', host)
      if (host !== modelHost) {
        throw new Error(`The test reaches only ${modelHost}`)
      }
      return Promise.resolve({ host: '127.0.0.1', port })
    },
    tls: { ca: caPem },
  }
  return {
    upstream,
    refused: (host: string) => {
      note('refused', host)
    },
  }
}
