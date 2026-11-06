import { describe, expect, it } from 'vitest'
import { extractPrRefs } from './pr-refs.js'

const SELF = { slug: 'acme/web', number: 10 }

const refs = (body: string) =>
  extractPrRefs(SELF, [{ place: 'body', text: body }]).map((ref) => `${ref.slug}#${String(ref.number)}`)

describe('extractPrRefs', () => {
  it('finds full URLs, owner/repo#N and bare #N in the own repo', () => {
    const body = [
      'Needs https://github.com/acme/api/pull/42/files first.',
      'Pairs with acme/worker#7 and #12.',
      'Tracked in https://github.com/acme/api/issues/5.',
    ].join('\n')
    expect(extractPrRefs(SELF, [{ place: 'body', text: body }])).toEqual([
      { slug: 'acme/api', number: 42, place: 'body', pull: true },
      { slug: 'acme/api', number: 5, place: 'body', pull: false },
      { slug: 'acme/worker', number: 7, place: 'body', pull: false },
      { slug: 'acme/web', number: 12, place: 'body', pull: false },
    ])
  })

  it('drops self references and repeats, keeping the first place', () => {
    const texts = [
      { place: 'title' as const, text: 'Backport #12 to main' },
      { place: 'body' as const, text: 'Same as #12, see #10 and https://github.com/acme/web/pull/10' },
      { place: 'comment' as const, text: 'ACME/WEB#12 again' },
    ]
    expect(extractPrRefs(SELF, texts)).toEqual([{ slug: 'acme/web', number: 12, place: 'title', pull: false }])
  })

  it('ignores code, HTML comments, anchors and entities', () => {
    const body = [
      '<!-- Closes #1 -->',
      'Run `git log #2` here.',
      '```',
      'see acme/api#3',
      '```',
      'Docs at https://example.com/page#4 and &#5; and foo#6',
      '~~~~ unclosed fence',
      '#7',
    ].join('\n')
    expect(refs(body)).toEqual([])
  })

  it('keeps references after a closed fence and ignores lookalike URLs', () => {
    const body = ['```ts', 'const x = 1 // #8', '```', 'Follows #9.', 'https://gitlab.com/acme/api/pull/3'].join('\n')
    expect(refs(body)).toEqual(['acme/web#9'])
  })

  it('caps the references per PR', () => {
    const body = Array.from({ length: 80 }, (_, i) => `#${String(i + 100)}`).join(' ')
    expect(refs(body)).toHaveLength(50)
  })
})
