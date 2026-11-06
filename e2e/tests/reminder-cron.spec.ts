import { test } from './support/fixtures.js'
import { cronReminderRoundTrip } from './support/reminder-cron.js'

test('a reminder runs on a cron schedule in its timezone and goes back to an interval', async ({ page, request }) => {
  test.setTimeout(60_000)
  await cronReminderRoundTrip(page, request, { press: async (target) => target.click(), phone: false })
})
