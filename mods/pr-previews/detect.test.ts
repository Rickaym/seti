import type { PrComment } from '@seti/mod-api'
import { describe, expect, it } from 'vitest'
import { detectPreview } from './detect.js'

const READY_BODY = `## Preview Environment Ready

**Preview URL:** https://pr-2175-staging.example.com

| Detail | Value |
|--------|-------|
| PR | #2175 |
| Commit | \`0349554\` |
| Image | \`dashboard-pr-2175-20260917-0349554\` |
| Database | Staging (Frankfurt) |
| Triggered by | push (\`labeled\`, auto-redeploy) |
| Expires | 7 days from now |

Add the **\`preview\`** label to auto-redeploy on every push; remove it to stop.
> Redeploy and reset the 7-day timer by pushing (label-gated) or commenting \`/deploy-preview\`.`

const EXPIRED_BODY = `## Preview Environment Expired

The preview environment for this PR has been automatically cleaned up after **7 days** of inactivity.

| Resource | Status |
|----------|--------|
| ECS Service | Deleted |

> To recreate the preview environment, comment \`/deploy-preview\` on this PR.`

const HEAD = '0349554a1b2c3d4e5f60718293a4b5c6d7e8f901'

const bot = (body: string, updatedAt: string): PrComment => ({ author: 'github-actions', body, updatedAt })

describe('detectPreview', () => {
  it('reads url and commit from a Ready comment', () => {
    expect(detectPreview([bot(READY_BODY, '2026-09-17T10:00:00Z')], HEAD)).toEqual({
      state: 'ready',
      url: 'https://pr-2175-staging.example.com',
      commit: '0349554',
      stale: false,
    })
  })

  it('marks a preview stale when its commit is not the head commit', () => {
    const preview = detectPreview([bot(READY_BODY, '2026-09-17T10:00:00Z')], 'f608484ffff')
    expect(preview.state).toBe('ready')
    expect(preview.stale).toBe(true)
  })

  it('lets the latest Ready or Expired comment decide', () => {
    const comments = [
      bot(READY_BODY, '2026-09-17T10:00:00Z'),
      bot(EXPIRED_BODY, '2026-09-25T03:13:39Z'),
      bot('## Some other bot report', '2026-09-26T00:00:00Z'),
    ]
    expect(detectPreview(comments, HEAD)).toEqual({ state: 'expired', url: null, commit: null, stale: false })
    expect(detectPreview([...comments, bot(READY_BODY, '2026-09-26T01:00:00Z')], HEAD).state).toBe('ready')
  })

  it('counts a Ready comment the workflow edited after the Expired comment as current', () => {
    const comments = [bot(READY_BODY, '2026-09-26T08:00:00Z'), bot(EXPIRED_BODY, '2026-09-25T03:13:39Z')]
    expect(detectPreview(comments, HEAD).state).toBe('ready')
  })

  it('ignores preview comments from anyone but the Actions bot', () => {
    const spoofed = { author: 'someone', body: READY_BODY, updatedAt: '2026-09-17T10:00:00Z' }
    expect(detectPreview([spoofed, { ...spoofed, author: null }], HEAD).state).toBe('none')
  })

  it('accepts the REST style bot login', () => {
    const comment = { author: 'github-actions[bot]', body: READY_BODY, updatedAt: '2026-09-17T10:00:00Z' }
    expect(detectPreview([comment], HEAD).state).toBe('ready')
  })

  it('refuses Ready comments without an https url', () => {
    const body = READY_BODY.replace('https:', 'ftp:')
    expect(detectPreview([bot(body, '2026-09-17T10:00:00Z')], HEAD).state).toBe('none')
  })

  it('returns none without any preview comment', () => {
    expect(detectPreview([], HEAD)).toEqual({ state: 'none', url: null, commit: null, stale: false })
  })
})
