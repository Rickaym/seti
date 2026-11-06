import { test } from './support/fixtures.js'
import { cronReminderRoundTrip } from './support/reminder-cron.js'

test('a reminder takes a cron schedule and goes back to an interval on a phone', async ({ page, request }) => {
  test.setTimeout(60_000)
  await cronReminderRoundTrip(page, request, { press: async (target) => target.tap(), phone: true })
})
