import { proseQuestion } from '@seti/shared'
import { describe, expect, it } from 'vitest'

interface Row {
  name: string
  text: string
  /** What a person reading the reply would say it asks. */
  asks: boolean
  question?: string
  options?: string[]
  closed?: boolean
  /** A known limit: the part the detector gets wrong on purpose, and why. */
  limit?: { wrong: 'asks' | 'options'; why: string }
}

const ASKING: Row[] = [
  { name: 'a lone question', text: 'Which branch should I use?', asks: true, closed: false },
  {
    name: 'a question after a report, with trailing space',
    text: 'I fixed the test.\n\nShould I merge it?  \n\n \t\n',
    asks: true,
    question: 'Should I merge it?',
    closed: true,
  },
  { name: 'a bold question', text: '**Want me to open a PR?**', asks: true, question: 'Want me to open a PR?' },
  {
    name: 'a question in brackets',
    text: 'The PR is open.\n\n(Or should I wait for review?)',
    asks: true,
    question: 'Or should I wait for review?',
  },
  { name: 'a question above a code block', text: 'Shall I apply this diff?\n\n```diff\n- a\n+ b\n```', asks: true },
  { name: 'a question below a code block', text: '~~~\nrm old.ts\n~~~\n\nOk to push this to main?', asks: true },
  {
    name: 'a question with inline code before its mark',
    text: 'Tests pass. Should I run `pnpm check` too?',
    asks: true,
    question: 'Should I run pnpm check too?',
  },
  { name: 'a question about a quoted word', text: 'Did you mean the "dev" branch?', asks: true },
  {
    name: 'two questions in a row',
    text: 'Both work. Should I rebase? Or would you rather I merge?',
    asks: true,
    question: 'Should I rebase? Or would you rather I merge?',
  },
  {
    name: 'a question holding an abbreviation',
    text: 'CI is green.\n\nDo you want me to merge it, e.g. With a squash?',
    asks: true,
    question: 'Do you want me to merge it, e.g. With a squash?',
  },
  { name: 'a short go-ahead', text: 'The image is built.\n\nReady to deploy?', asks: true, closed: true },
  { name: 'a go-ahead on a plan', text: 'I would split it into two PRs. Does that sound good?', asks: true },
  { name: 'an open question', text: 'What should I name the new table?', asks: true, closed: false },
  {
    name: 'a why question put to the user',
    text: 'I found the caller. Why do you want the retry at all?',
    asks: true,
    closed: false,
  },
  {
    name: 'a question after a quote block',
    text: 'The migration is destructive:\n\n> DROP TABLE runs first\n\nProceed?',
    asks: true,
  },
  {
    name: 'numbered options after the question',
    text: 'The fix is ready on two branches.\n\nWhich one should I push?\n\n1. main\n2. release',
    asks: true,
    question: 'Which one should I push?',
    options: ['main', 'release'],
    closed: false,
  },
  {
    name: 'options with Markdown, right under the question',
    text: 'Which one should I push?\n1) `main`\n2) **release**: the hotfix branch',
    asks: true,
    options: ['main', 'release: the hotfix branch'],
  },
  {
    name: 'lettered options before the question',
    text: 'I see two options:\n\na) Rebase onto main\nb) Merge main in\n\nWhich do you prefer?',
    asks: true,
    question: 'Which do you prefer?',
    options: ['Rebase onto main', 'Merge main in'],
  },
  {
    name: 'bullets introduced as alternatives',
    text: 'There are two ways to fix this:\n\n- Pin the dependency\n- Patch the call site\n\nHow should I proceed?',
    asks: true,
    options: ['Pin the dependency', 'Patch the call site'],
  },
  {
    name: 'five options, of which four are kept',
    text: 'A. Keep both\nB. Keep the new one\nC. Keep the old one\nD. Delete both\nE. Ask later\n\nWhich option should I take?',
    asks: true,
    options: ['Keep both', 'Keep the new one', 'Keep the old one', 'Delete both'],
  },
  {
    name: 'an option that wraps onto a second line',
    text: 'Which do you want?\n1. Rebase, which keeps\n   history linear\n2. Merge',
    asks: true,
    options: ['Rebase, which keeps history linear', 'Merge'],
  },
  {
    name: 'a list of questions',
    text: 'Two choices left:\n1. Keep the table?\n2. Drop the column?',
    asks: true,
    question: 'Two choices left',
    options: ['Keep the table?', 'Drop the column?'],
  },
  {
    name: 'a question about the files listed under it',
    text: 'Should I also update these?\n- a.ts\n- b.ts',
    asks: true,
    options: [],
    closed: true,
  },
  {
    name: 'a question as the last bullet',
    text: 'Next steps:\n- Merge the PR\n- Should I also deploy it?',
    asks: true,
    question: 'Should I also deploy it?',
    options: [],
  },
  {
    name: 'a summary list before a yes or no question',
    text: 'I changed two files:\n\n- a.ts\n- b.ts\n\nShould I open a PR?',
    asks: true,
    options: [],
  },
  {
    name: 'a question, then a remark',
    text: 'Want me to push it? It is a one-line change.',
    asks: true,
    limit: { wrong: 'asks', why: 'a remark after a question reads the same as the agent answering itself' },
  },
  {
    name: 'a question, then a request to answer',
    text: 'Merge now or wait for review? Let me know.',
    asks: true,
    limit: { wrong: 'asks', why: 'the reply ends on a statement' },
  },
  {
    name: 'a choice whose question names neither the user nor a choice',
    text: 'Rebase or merge?\n1. Rebase keeps history linear\n2. Merge keeps the branch',
    asks: true,
    limit: { wrong: 'asks', why: 'a list under such a question is usually the answer to it' },
  },
  {
    name: 'a report list before a which question',
    text: '1. Fixed the parser\n2. Added a test\n\nWhich branch should I push to?',
    asks: true,
    options: [],
    limit: { wrong: 'options', why: 'a list right before a which question is taken as its answers' },
  },
]

const NOT_ASKING: Row[] = [
  { name: 'a statement', text: 'Done.', asks: false },
  { name: 'nothing', text: '', asks: false },
  { name: 'a question answered in the same paragraph', text: 'Why did CI fail? The cache was stale.', asks: false },
  { name: 'why, because', text: 'Why did it fail? Because the token expired.', asks: false },
  { name: 'a yes or no the agent answers', text: 'Is the cache stale? No: the key includes the commit.', asks: false },
  {
    name: 'a question in the middle, then a statement paragraph',
    text: 'Should I keep the flag?\n\nI kept it, since two callers read it.',
    asks: false,
  },
  {
    name: 'a question mark only in fenced code',
    text: 'The new rule:\n\n```ts\nconst name = user?.name ?? "who?"\n```',
    asks: false,
  },
  { name: 'a question mark in a tilde fence', text: 'The pattern:\n\n~~~\n/colou?r?/\n~~~\n', asks: false },
  { name: 'a question mark in an unclosed fence', text: 'Run this:\n\n```sh\necho "ready?"', asks: false },
  { name: 'a question mark in inline code', text: 'The flag is named `retry?`', asks: false },
  { name: 'a quoted error', text: 'The check failed with "file not found?"', asks: false },
  { name: 'a quoted user', text: 'You asked "can we ship today?"', asks: false },
  { name: 'a quoted question in a statement', text: 'The question "should we cache?" is still open.', asks: false },
  { name: 'a quote block', text: 'The reviewer wrote:\n\n> Why is this not behind a flag?', asks: false },
  {
    name: 'a heading with its answer',
    text: '## Why did the build fail?\n\nThe lockfile was out of date.',
    asks: false,
  },
  { name: 'a heading alone', text: 'Report below.\n\n## What changed?', asks: false },
  {
    name: 'a question answered by a list',
    text: 'What changed?\n- The retry now backs off\n- The timeout is 30s',
    asks: false,
  },
  {
    name: 'a which question answered by a list',
    text: 'Which files changed?\n1. server/src/a.ts\n2. ui/src/b.tsx',
    asks: false,
  },
  {
    name: 'a list of questions with their answers',
    text: '1. Why was it slow? The query had no index.\n2. Is it fixed? Yes.',
    asks: false,
  },
  { name: 'a table', text: '| Question | Answer |\n| --- | --- |\n| Cache? | Yes |', asks: false },
  { name: 'a plain list', text: 'Tests:\n- unit pass\n- e2e pass', asks: false },
  { name: 'the agent musing', text: 'The fix works. So why does the test pass locally?', asks: false },
  { name: 'the agent wondering', text: 'I wonder if the cache is even needed?', asks: false },
  { name: 'anything else', text: 'All done. Anything else?', asks: false },
  { name: 'does that make sense', text: 'The PR is open.\n\nDoes that make sense?', asks: false },
  {
    name: 'a long closing courtesy',
    text: 'Merged and deployed. Is there anything else you would like me to change?',
    asks: false,
  },
  { name: 'any questions', text: 'Done. Any questions?', asks: false },
  {
    name: 'what next',
    text: 'That is everything on the list. What would you like me to do next?',
    asks: false,
  },
  { name: 'two courtesies', text: 'Shipped. Does that help? Anything else?', asks: false },
  {
    name: 'a rhetorical question at the end',
    text: 'Fixed. Who would have guessed?',
    asks: false,
    limit: { wrong: 'asks', why: 'nothing marks it as rhetorical' },
  },
  {
    name: 'a rhetorical question inside a sentence',
    text: 'The table has no index, so how did this ever work?',
    asks: false,
    limit: { wrong: 'asks', why: 'the musing opener is not at the start of the sentence' },
  },
  {
    name: 'a courtesy in other words',
    text: 'All set. Want anything else changed?',
    asks: false,
    limit: { wrong: 'asks', why: 'only the listed courtesies are left out' },
  },
]

const TABLE = [...ASKING, ...NOT_ASKING]
const exact = TABLE.filter((row) => row.limit === undefined)
const wrongOn = (part: 'asks' | 'options') => TABLE.filter((row) => row.limit?.wrong === part)

describe('proseQuestion', () => {
  it.each(exact)('reads $name', ({ text, asks, question, options, closed }) => {
    const found = proseQuestion(text)
    expect(found.asks).toBe(asks)
    expect(found).toMatchObject({
      ...(question === undefined ? {} : { question }),
      ...(options === undefined ? {} : { options }),
      ...(closed === undefined ? {} : { closed }),
    })
    if (!asks) {
      expect(found).toEqual({ asks: false, question: '', options: [], closed: false })
    }
  })

  it.each(wrongOn('asks'))('still misreads $name', ({ text, asks }) => {
    expect(proseQuestion(text).asks).toBe(!asks)
  })

  it.each(wrongOn('options'))('still offers the wrong answers for $name', ({ text, asks, options }) => {
    const found = proseQuestion(text)
    expect(found.asks).toBe(asks)
    expect(found.options).not.toEqual(options)
  })

  it('misreads only the known limits of the table', () => {
    const missed = TABLE.filter((row) => proseQuestion(row.text).asks !== row.asks)
    expect({
      rows: TABLE.length,
      asking: ASKING.length,
      false_negatives: missed.filter((row) => row.asks).map((row) => row.name),
      false_positives: missed.filter((row) => !row.asks).map((row) => row.name),
    }).toEqual({
      rows: 61,
      asking: 29,
      false_negatives: [
        'a question, then a remark',
        'a question, then a request to answer',
        'a choice whose question names neither the user nor a choice',
      ],
      false_positives: [
        'a rhetorical question at the end',
        'a rhetorical question inside a sentence',
        'a courtesy in other words',
      ],
    })
  })

  it('keeps a long question to one clipped line', () => {
    const { question } = proseQuestion(`Should I ${'really '.repeat(60)}merge\nit?`)
    expect(question).toHaveLength(200)
    expect(question.endsWith('...')).toBe(true)
    expect(question).not.toContain('\n')
  })
})
