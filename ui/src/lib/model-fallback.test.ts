import { modelFallbackOf, type ModelFallbackMessage } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { fallbackHint, linkParts, noticeSentence, stillOn, verificationLink } from '@/lib/model-fallback'

const CVP = 'https://support.claude.com/en/articles/14604842-cyber-verification-program'

function notice(extra: Record<string, unknown> = {}): ModelFallbackMessage {
  const parsed = modelFallbackOf({
    type: 'system',
    subtype: 'model_refusal_fallback',
    trigger: 'refusal',
    direction: 'retry',
    scope: 'session',
    original_model: 'claude-opus-5-5',
    fallback_model: 'claude-opus-4-8',
    request_id: 'req_1',
    api_refusal_category: 'cyber',
    api_refusal_explanation: `Cyber safeguards flagged this message. Apply here: ${CVP}.`,
    api_refusal_cyber_verification: { type: 'inactive' },
    content: 'flagged',
    ...extra,
  })
  if (parsed === null) {
    throw new Error('not a fallback notice')
  }
  return parsed
}

const NOW = {
  original_model: 'claude-opus-5-5',
  fallback_model: 'claude-opus-4-8',
  category: 'cyber',
  request_id: null,
  at: '',
}

describe('model fallback notice', () => {
  it('says what Claude Code did in model names', () => {
    expect(noticeSentence(notice())).toBe(
      'Claude Code switched this agent from Opus 5.5 to Opus 4.8 after a cyber safeguard flagged a request.',
    )
    expect(noticeSentence(notice({ api_refusal_category: null }))).toBe(
      'Claude Code switched this agent from Opus 5.5 to Opus 4.8 after a safeguard flagged a request.',
    )
    expect(noticeSentence(notice({ scope: 'local' }))).toBe(
      'Claude Code answered one subagent request on Opus 4.8 after a cyber safeguard flagged a request; the agent stays on Opus 5.5.',
    )
    expect(fallbackHint(NOW)).toBe(
      'On Opus 4.8 since a cyber safeguard flagged a request; Switch back returns it to Opus 5.5',
    )
  })

  it('links the explanation and keeps the full stop out of the link', () => {
    expect(linkParts(`See ${CVP}. Then retry.`)).toEqual([
      { text: 'See ' },
      { text: CVP, href: CVP },
      { text: '. Then retry.' },
    ])
    expect(linkParts('No link here')).toEqual([{ text: 'No link here' }])
  })

  it('finds the Cyber Verification Program link only when Claude Code reported verification', () => {
    expect(verificationLink(notice())).toBe(CVP)
    expect(verificationLink(notice({ api_refusal_cyber_verification: undefined }))).toBeNull()
    expect(
      verificationLink(notice({ api_refusal_cyber_verification: { type: 'inactive', url: 'https://x.test/v' } })),
    ).toBe('https://x.test/v')
  })

  it('offers Switch back only while the task is still on the fallback this notice reported', () => {
    expect(stillOn(notice(), NOW)).toBe(true)
    expect(stillOn(notice(), null)).toBe(false)
    expect(stillOn(notice({ scope: 'local' }), NOW)).toBe(false)
    expect(stillOn(notice({ fallback_model: 'claude-sonnet-4-5' }), NOW)).toBe(false)
  })
})
