import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { nextRunTimes, type ChannelInfo, type EaFollowup, type Envelope } from '@seti/shared'
import { apiData, expect } from './fixtures.js'
import { expectFitsPhone } from './phone-layout.js'

/** A click on desktop, a tap on a phone. */
type Press = (target: Locator) => Promise<void>

const CRON = '30 14 * * *'
const TIMEZONE = 'America/New_York'
const POLL = 'export default async function poll() {\n  return []\n}\n'
const REMIND = "export default () => 'Stand up'\n"

async function create<T>(request: APIRequestContext, path: string, data: object): Promise<T> {
  const response = await request.post(`/api${path}`, { data })
  expect(response.ok(), `POST /api${path}`).toBe(true)
  return ((await response.json()) as Envelope<T>).data
}

/** A clock time as the browser shows it, in its own timezone. */
const localClock = async (page: Page, iso: string) =>
  page.evaluate(
    (at) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    iso,
  )

/** A frequent poller, a cron reminder in another timezone, a paused one and a follow-up. */
async function seed(request: APIRequestContext, tag: string) {
  const feed = await create<ChannelInfo>(request, '/channels/pollers', {
    name: `Sched feed ${tag}`,
    script: POLL,
    interval_s: 300,
  })
  const standup = await create<ChannelInfo>(request, '/channels/reminders', {
    name: `Sched standup ${tag}`,
    script: REMIND,
    schedule: { cron: CRON, timezone: TIMEZONE },
  })
  const resting = await create<ChannelInfo>(request, '/channels/reminders', {
    name: `Sched resting ${tag}`,
    script: REMIND,
    enabled: false,
  })
  const followup = await create<EaFollowup>(request, '/ea/followups', {
    kind: 'reminder',
    when: 'in 2 hours',
    timezone: 'Europe/Berlin',
    note: `Sched call ${tag}`,
  })
  await expect
    .poll(async () => {
      const info = await apiData<ChannelInfo>(request, `/channels/pollers/${feed.id}`)
      return info.source === 'poller' ? info.poller.next_run_at : null
    })
    .not.toBeNull()
  return { feed, standup, resting, followup }
}

/** Opens the schedule, reads it over each range, and follows its links to the cards. */
export async function scheduleShowsWhatRunsNext(
  page: Page,
  request: APIRequestContext,
  { press, phone }: { press: Press; phone: boolean },
): Promise<void> {
  const { feed, standup, resting, followup } = await seed(request, randomUUID().slice(0, 8))
  try {
    await page.goto('/#settings/channels')
    const main = page.getByRole('main')
    await press(main.getByRole('tab', { name: 'Schedule' }))
    await expect(page).toHaveURL(/#settings\/channels\/schedule$/)
    await expect(main.getByText('Times in Europe/Berlin')).toBeVisible()
    await expect(main.getByRole('tab', { name: '7 d' })).toHaveAttribute('aria-selected', 'true')

    const tomorrow = main.getByRole('region', { name: 'Tomorrow' })
    await expect(tomorrow.getByRole('button', { name: feed.name })).toContainText('Every 5 min, 288 runs')
    await expect(tomorrow.getByRole('button', { name: feed.name })).toContainText('Poller')
    await expect(main.getByRole('button', { name: feed.name })).toHaveCount(8)

    const [nextStandup = ''] = nextRunTimes(CRON, TIMEZONE, 1)
    const rows = main.getByRole('button', { name: standup.name })
    await expect(rows).toHaveCount(7)
    await expect(rows.first()).toContainText(await localClock(page, nextStandup))
    await expect(rows.first()).toContainText(`At 14:30 (${TIMEZONE} time)`)
    await expect(rows.first()).toContainText('Reminder')
    await expect(main.getByRole('button', { name: followup.title })).toContainText('The EA reminds you')
    if (phone) {
      await expectFitsPhone(page, 'the channel schedule')
    }

    await press(main.getByRole('tab', { name: '24 h' }))
    await expect(rows).toHaveCount(1)
    await press(main.getByRole('tab', { name: '30 d' }))
    await expect(rows).toHaveCount(30)

    const paused = main.getByRole('region', { name: 'Paused' })
    await expect(paused).toContainText(' paused: ')
    await press(paused.getByRole('button', { name: resting.name }))
    await expect(page).toHaveURL(new RegExp(`#settings/channels/${resting.id}$`))
    await expect(main.getByRole('tab', { name: 'Channels' })).toHaveAttribute('aria-selected', 'true')
    await expect(main.getByRole('region', { name: resting.name })).toBeInViewport()

    await press(main.getByRole('tab', { name: 'Schedule' }))
    await press(rows.first())
    await expect(page).toHaveURL(new RegExp(`#settings/channels/${standup.id}$`))
    await expect(main.getByRole('region', { name: standup.name })).toBeInViewport()
  } finally {
    await request.delete(`/api/channels/${feed.id}`)
    await request.delete(`/api/channels/${standup.id}`)
    await request.delete(`/api/channels/${resting.id}`)
    await request.delete(`/api/ea/followups/${String(followup.id)}`)
  }
}
