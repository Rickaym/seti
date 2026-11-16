import { scheduleShowsWhatRunsNext } from './support/channel-schedule.js'
import { test } from './support/fixtures.js'

test('the schedule lists what runs next and opens a channel on a phone', async ({ page, request }) => {
  test.setTimeout(60_000)
  await scheduleShowsWhatRunsNext(page, request, { press: async (target) => target.tap(), phone: true })
})
