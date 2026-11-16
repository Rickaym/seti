import { scheduleShowsWhatRunsNext } from './support/channel-schedule.js'
import { test } from './support/fixtures.js'

test('the schedule lists what pollers, reminders and the EA run next, by day', async ({ page, request }) => {
  test.setTimeout(60_000)
  await scheduleShowsWhatRunsNext(page, request, { press: async (target) => target.click(), phone: false })
})
