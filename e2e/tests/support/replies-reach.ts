import type { APIRequestContext, Page } from '@playwright/test'
import type { ChannelInfo, PollerChannelInfo } from '@seti/shared'
import { openAgentSettings } from './agent-settings.js'
import { expect } from './fixtures.js'
import { expectFitsPhone } from './phone-layout.js'
import { seedFollower } from './slack-settings.js'
import { shot, slackWebhookWithReplies } from './thread-replies.js'

const LINE = 'Replies need a Slack webhook'

/** Turns Thread replies off on every webhook, so no reply has a way in. */
async function noReplyWebhooks(request: APIRequestContext): Promise<void> {
  const listed = await request.get('/api/channels')
  expect(listed.ok()).toBe(true)
  const channels = ((await listed.json()) as { data: ChannelInfo[] }).data
  for (const channel of channels) {
    if (channel.source === 'webhook' && channel.threads?.replies === true) {
      const off = await request.put(`/api/channels/${channel.id}/threads`, { data: { replies: false } })
      expect(off.ok()).toBe(true)
    }
  }
}

/** A paused poller whose own hosts include Slack, as a mentions poller has. */
async function slackPoller(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post('/api/channels/pollers', {
    data: { name, script: 'export default async () => []', extra_hosts: ['slack.com'], enabled: false },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { data: PollerChannelInfo }).data.id
}

async function teamLine(page: Page, agent: string) {
  await page.goto(`/#agents/${agent}`)
  const dialog = await openAgentSettings(page, 'Team')
  await expect(dialog.getByTestId('task-threads')).toContainText('#deploys')
  return dialog.getByTestId('replies-need-webhook')
}

/**
 * With an agent following a thread and no webhook reading replies, a Slack poller's card and the
 * agent's Team tab say replies need a Slack webhook; a webhook with Threads on clears both.
 */
export async function expectRepliesNeedWebhook(
  page: Page,
  request: APIRequestContext,
  { name, channel, tap }: { name: string; channel: string; tap: boolean },
): Promise<void> {
  await noReplyWebhooks(request)
  const agent = await seedFollower(`${name} agent`, channel)
  const poller = await slackPoller(request, name)
  try {
    await page.goto('/#settings/channels')
    const card = page.getByRole('main').getByRole('region', { name, exact: true })
    const line = card.getByTestId('replies-need-webhook')
    await expect(line).toHaveText(LINE)
    await line.scrollIntoViewIfNeeded()
    if (!tap) {
      await line.hover()
      await expect(page.getByRole('tooltip')).toContainText('only through a Slack webhook with Threads on')
    }
    await shot(page, 'poller-replies-hint')
    if (tap) {
      await expectFitsPhone(page, 'a Slack poller card saying replies need a webhook')
    }
    const teamHint = await teamLine(page, agent)
    await expect(teamHint).toHaveText(LINE)
    await shot(page, 'team-replies-hint')
    if (tap) {
      await expectFitsPhone(page, 'the Team tab saying replies need a webhook')
    }
    await (tap ? teamHint.tap() : teamHint.click())
    await expect(page).toHaveURL(/#settings\/channels$/)

    const webhook = await slackWebhookWithReplies(request, `${name} webhook`)
    try {
      await expect(await teamLine(page, agent)).toHaveCount(0)
      await page.goto('/#settings/channels')
      await expect(page.getByRole('main').getByRole('region', { name, exact: true })).toBeVisible()
      await expect(card.getByTestId('replies-need-webhook')).toHaveCount(0)
    } finally {
      await request.delete(`/api/channels/${webhook.channel.id}`)
    }
  } finally {
    await request.delete(`/api/channels/${poller}`)
  }
}
