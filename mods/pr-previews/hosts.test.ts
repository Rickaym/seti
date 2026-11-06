import type { OpenPrSummary, Preview } from '@seti/mod-api'
import { describe, expect, it } from 'vitest'
import { previewHost, previewTarget } from './hosts.js'

const READY: Preview = { state: 'ready', url: 'https://pr-2-staging.example.com', commit: 'abc1234', stale: false }

const pr = (number: number, preview: Preview, host: string | null): OpenPrSummary => ({
  repo_slug: 'globex/dashboard',
  number,
  url: `https://github.com/globex/dashboard/pull/${String(number)}`,
  preview,
  preview_host: host,
})

describe('previewHost', () => {
  it('names the subdomain after the repo and the PR number', () => {
    expect(previewHost('globex/Voice_Bot', 12)).toBe('voice-bot-pr-12.seti.localhost')
  })
})

describe('previewTarget', () => {
  it('resolves only hosts of ready previews', () => {
    const prs = [
      pr(1, { ...READY, state: 'expired', url: null }, null),
      pr(2, READY, 'dashboard-pr-2.seti.localhost'),
      pr(3, { ...READY, state: 'expired' }, 'dashboard-pr-3.seti.localhost'),
    ]
    expect(previewTarget(prs, 'dashboard-pr-2.seti.localhost')).toBe('https://pr-2-staging.example.com')
    expect(previewTarget(prs, 'dashboard-pr-1.seti.localhost')).toBeNull()
    expect(previewTarget(prs, 'dashboard-pr-3.seti.localhost')).toBeNull()
  })
})
