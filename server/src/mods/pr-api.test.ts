import type { ModDefinition } from '@seti/mod-api'
import { prPreviewsServer } from '@seti/mod-pr-previews/server'
import type { Preview } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decoratePr, prDecorators, previewsOn } from '../pr-decorators.js'
import { hostProxies } from '../subdomain-proxy.js'
import { ModHost } from './host.js'

const READY: Preview = { state: 'ready', url: 'https://pr-7.example.com', commit: 'abc1234', stale: false }

vi.mock('../prs.js', () => ({
  cachedOpenPrs: async () =>
    Promise.resolve([
      { repo_slug: 'acme/web', number: 7, url: 'u', preview: READY, preview_host: 'web-pr-7.seti.localhost', refs: [] },
    ]),
}))

const READY_COMMENT = {
  author: 'github-actions[bot]',
  body: '## Preview Environment Ready\n\n**Preview URL:** https://pr-7.example.com/\n\n| Commit | `abc1234` |',
  updatedAt: '2026-11-01T00:00:00Z',
}

const hosts: ModHost[] = []

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.stopAll()
  }
})

function hostOf(definition: ModDefinition): ModHost {
  const host = new ModHost([{ definition, tier: 'bundled' }])
  hosts.push(host)
  return host
}

const probe = (contributes: Record<string, unknown>, server: NonNullable<ModDefinition['server']>): ModDefinition => ({
  manifest: { id: 'probe', name: 'Probe', version: '1.0.0', seti: '^1.6', description: 'A probe', contributes },
  server,
})

const resolve = async (host: string) => hostProxies.list()[0]?.resolve(host) ?? null

describe('the PR previews mod', () => {
  it('decorates PRs and serves their hosts while on, and leaves nothing behind when off', async () => {
    const host = hostOf(prPreviewsServer)
    await host.setEnabled('pr-previews', true)
    expect(previewsOn()).toBe(true)
    expect(decoratePr({ slug: 'acme/web', number: 7, headOid: 'abc1234ff' }, [READY_COMMENT])).toEqual({
      preview: READY,
      preview_host: 'web-pr-7.seti.localhost',
    })
    expect((await resolve('web-pr-7.seti.localhost'))?.origin).toBe('https://pr-7.example.com')
    expect(await resolve('web-pr-8.seti.localhost')).toBeNull()

    await host.setEnabled('pr-previews', false)
    expect(previewsOn()).toBe(false)
    expect(hostProxies.list()).toEqual([])
    expect(decoratePr({ slug: 'acme/web', number: 7, headOid: 'abc1234ff' }, [READY_COMMENT]).preview.state).toBe(
      'none',
    )
  })
})

describe('the host proxy point', () => {
  it('serves only HTTPS origins, and a resolver that throws serves nothing', async () => {
    const answers = ['http://127.0.0.1:8080', 'https://x.example/path', 'https://x.example']
    const host = hostOf(
      probe({ hostProxies: [{ id: 'web', title: 'Web' }] }, (api) => {
        api.registerHostProxy('web', async (name) => {
          const answer = answers.shift()
          return name === 'boom.seti.localhost' || answer === undefined
            ? Promise.reject(new Error('boom'))
            : Promise.resolve(answer)
        })
      }),
    )
    await host.setEnabled('probe', true)
    expect(await resolve('a.seti.localhost')).toBeNull()
    expect(await resolve('a.seti.localhost')).toBeNull()
    expect((await resolve('a.seti.localhost'))?.origin).toBe('https://x.example')
    expect(await resolve('boom.seti.localhost')).toBeNull()
  })

  it('refuses a proxy or a decorator the manifest does not declare', async () => {
    const proxy = hostOf(
      probe({}, (api) => {
        api.registerHostProxy('web', async () => Promise.resolve(null))
      }),
    )
    await expect(proxy.setEnabled('probe', true)).rejects.toThrow('host proxy web')
    const reader = hostOf(
      probe({}, async (api) => {
        await api.prs.open()
      }),
    )
    await expect(reader.setEnabled('probe', true)).rejects.toThrow('without declaring a PR decorator')
    expect(hostProxies.list()).toEqual([])
    expect(prDecorators.list()).toEqual([])
  })
})

describe('decoratePr', () => {
  it('drops what a decorator gives that is not an HTTPS preview on a Seti subdomain', () => {
    const subject = { slug: 'acme/web', number: 7, headOid: 'abc' }
    const dispose = prDecorators.register({
      key: 'test.bad',
      decorate: () => ({ preview: { ...READY, url: 'http://127.0.0.1:9' }, preview_host: 'evil.example.com' }),
    })
    expect(decoratePr(subject, [])).toEqual({
      preview: { state: 'none', url: null, commit: null, stale: false },
      preview_host: null,
    })
    dispose()
    const host = prDecorators.register({
      key: 'test.host',
      decorate: () => ({ preview: READY, preview_host: 'x.com' }),
    })
    expect(decoratePr(subject, [])).toEqual({ preview: READY, preview_host: null })
    host()
  })
})
