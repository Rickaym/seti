import type { Page } from '@playwright/test'
import { seedReply } from './link-pills.js'

/** The sources the seeded reply cites, and how each reads. */
export const SOURCES = {
  pr: { url: 'https://github.com/acme/widgets/pull/12', label: 'acme/widgets#12', host: 'github.com' },
  slack: {
    url: 'https://acme.slack.com/archives/C08ABCDEF12/p1731000000123456',
    label: 'Slack message',
    host: 'acme.slack.com',
  },
  issue: { url: 'https://linear.app/acme/issue/ENG-42/fix-login', label: 'ENG-42', host: 'linear.app' },
  note: 'Standup notes, 24 November',
  runbook: { url: 'https://example.com/runbooks/release', label: 'example.com/runbooks/release' },
  attached: { url: 'https://example.com/reports/q3', label: 'example.com/reports/q3' },
} as const

export const QUOTE = 'We ship on Friday, not Thursday.'

/** A reply that cites in every form: links and bare URLs in sentences, a quote, footnotes, `[n]`. */
const REPLY = [
  `The deploy moved to Friday after [the release review](${SOURCES.pr.url}), and the thread ${SOURCES.slack.url} agrees.`,
  `> ${QUOTE}`,
  `Dana said so in [the release thread](${SOURCES.slack.url}).`,
  `The login fix is tracked in ${SOURCES.issue.url}; the freeze holds.[^1] The runbook [2] has the steps.`,
  '- Checked `ui/src/App.tsx` for the banner',
  `Attached:\n${SOURCES.attached.url}`,
  `[^1]: ${SOURCES.note}`,
  `[2]: ${SOURCES.runbook.url}`,
].join('\n\n')

export const seedReferences = async (title: string): Promise<string> =>
  seedReply(title, REPLY, 'Where did the release land?')

export const SLACK_FILE = {
  url: 'https://acme.slack.com/files/U08ABCDEF12/F08ABCDEF12/q3-release-evaluation.pdf',
  label: 'Slack file q3 release evaluation',
}

/** A reply that pastes bare URLs into its sentences, as agents often do. */
const BARE_REPLY = [
  `Open it here: ${SLACK_FILE.url} and the fix is ${SOURCES.pr.url}, tracked in ${SOURCES.issue.url}.`,
  `The [release review](${SOURCES.pr.url}) and [${SOURCES.runbook.url}](${SOURCES.runbook.url}) agree.`,
  `Do not run \`${SOURCES.runbook.url}\` by hand.`,
].join(' ')

export const seedBareLinks = async (title: string): Promise<string> =>
  seedReply(title, BARE_REPLY, 'Where is the evaluation?')

/** The agent's reply with bare URLs in the transcript. */
export const bareReply = (page: Page) =>
  page.getByRole('region', { name: 'Transcript' }).locator('[data-find-text]').filter({ hasText: 'Open it here' })

/** The agent's reply in the transcript. */
export const referencedReply = (page: Page) =>
  page.getByRole('region', { name: 'Transcript' }).locator('[data-find-text]').filter({ hasText: 'The deploy moved' })

/** The mark of reference `n`; the first one when the message cites it more than once. */
export const markOf = (page: Page, n: number) =>
  referencedReply(page)
    .locator(`[data-reference="${String(n)}"]`)
    .first()

/** Serves every cited host locally, so opening a source never leaves the test machine. */
export async function serveSources(page: Page): Promise<void> {
  for (const host of ['github.com', 'acme.slack.com', 'linear.app', 'example.com']) {
    await page
      .context()
      .route(`https://${host}/**`, async (route) => route.fulfill({ body: 'source', contentType: 'text/plain' }))
  }
}
