import { describe, expect, it } from 'vitest'
import { normalise, quoteFits } from './quote.js'
import { refOfUrl } from './refs.js'

const SLACK_TEXT = [
  '> <@U0DANA0001|Dana> the *rollout* starts on _Monday_ at 09:00 &amp; ends Friday',
  '> see <https://example.com/plan|the plan> for the \u201cdetails\u201d',
  '> \u2022 first we drain the old pool',
].join('\n')

describe('quote check', () => {
  it('normalises markup, entities, quote marks and white space', () => {
    expect(normalise(SLACK_TEXT)).toBe(
      'Dana the rollout starts on Monday at 09:00 & ends Friday see the plan for the details first we drain the old pool',
    )
  })

  it.each([
    ['the exact words', 'the rollout starts on Monday at 09:00'],
    ['the words with Markdown emphasis and curly quotes', '\u201cthe **rollout** starts on Monday\u201d'],
    ['a quote across lines and a link label', 'ends Friday see the plan for the details'],
    ['a quote that leaves words out with an ellipsis', 'the rollout starts ... ends Friday'],
    ['a quote of a bullet', 'first we drain the old pool'],
  ])('verifies %s', (_name, quote) => {
    expect(quoteFits(quote, SLACK_TEXT)).toBe(true)
  })

  it.each([
    ['one word changed', 'the rollout starts on Tuesday at 09:00'],
    ['words in another order', 'starts the rollout on Monday at 09:00'],
    ['ellipsis parts out of order', 'ends Friday ... the rollout starts'],
    ['a number changed', 'the rollout starts on Monday at 10:00'],
    ['a quote too short to mean anything', 'Monday'],
    ['an empty quote', '...'],
  ])('does not verify %s', (_name, quote) => {
    expect(quoteFits(quote, SLACK_TEXT)).toBe(false)
  })
})

describe('cited URLs', () => {
  it.each([
    [
      'a Slack reply permalink, falling back to its thread and channel',
      'https://acme.slack.com/archives/C0SOURCE01/p1764000060000200?thread_ts=1764000000.000100&cid=C0SOURCE01',
      {
        ref: 'slack:C0SOURCE01/1764000060.000200',
        parents: ['slack:C0SOURCE01/1764000000.000100', 'slack:C0SOURCE01'],
        needles: ['1764000060.000200', 'p1764000060000200'],
      },
    ],
    ['a Slack channel link', 'https://acme.slack.com/archives/C0SOURCE01', { ref: 'slack:C0SOURCE01', needles: null }],
    ['a pull request', 'https://github.com/Acme/API/pull/12/files', { ref: 'github:acme/api#12', parents: [] }],
    [
      'a review comment',
      'https://github.com/acme/api/pull/12#discussion_r99',
      { ref: 'github:acme/api#12/discussion_r99', parents: ['github:acme/api#12'] },
    ],
    [
      'a Linear comment by the start of its id',
      'https://linear.app/acme/issue/ENG-12/a-title#comment-0000000a',
      { ref: 'linear:ENG-12#0000000a', parents: ['linear:ENG-12'], needles: null },
    ],
  ])('reads %s', (_name, href, want) => {
    expect(refOfUrl(href)).toMatchObject(want)
  })

  it.each([
    ['another host', 'https://example.com/archives/C0SOURCE01/p1764000060000200'],
    ['a look-alike Slack host', 'https://acme.slack.com.example.com/archives/C0SOURCE01'],
    ['a repository page', 'https://github.com/acme/api'],
    ['a file at a branch', 'https://github.com/acme/api/blob/main/README.md'],
    ['not a URL', 'see the plan'],
  ])('ignores %s', (_name, href) => {
    expect(refOfUrl(href)).toBeNull()
  })
})
