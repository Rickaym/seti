import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { nextRunTimes, type Envelope, type ReminderChannelInfo } from '@seti/shared'
import { apiData, expect, nextApiResponse } from './fixtures.js'
import { expectFitsPhone } from './phone-layout.js'

/** A click on desktop, a tap on a phone. */
type Press = (target: Locator) => Promise<void>

const CRON = '30 14 * * 1'
const TIMEZONE = 'America/New_York'
const NEXT_RUNS = /Next, in your local time: [^|]+\|[^|]+\|[^|]+$/

/** The card's next run as the browser formats it, in its own locale and timezone. */
const localWhen = async (page: Page, iso: string) =>
  page.evaluate(
    (at) =>
      new Date(at).toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
    iso,
  )

async function openNewReminder(page: Page, press: Press): Promise<Locator> {
  await page.goto('/#settings/channels')
  await press(page.getByRole('main').getByRole('button', { name: 'New', exact: true }))
  await press(page.getByRole('list', { name: 'Channel sources' }).getByRole('button', { name: /Reminder/ }))
  return page.getByRole('dialog', { name: 'New reminder' })
}

async function pickSchedule(page: Page, dialog: Locator, press: Press, option: string): Promise<void> {
  await press(dialog.getByRole('combobox', { name: 'Schedule' }))
  await press(page.getByRole('option', { name: option, exact: true }))
}

/** Turns cron on, tries a preset, a bad cron and a bad timezone, then sets a custom one. */
async function fillCron(page: Page, dialog: Locator, press: Press, phone: boolean): Promise<void> {
  const preview = dialog.getByTestId('schedule-preview')
  await expect(dialog.getByRole('spinbutton', { name: 'Interval' })).toBeVisible()
  await press(dialog.getByRole('switch', { name: 'Cron schedule' }))
  await expect(dialog.getByRole('spinbutton', { name: 'Interval' })).toBeHidden()
  const timezone = dialog.getByRole('textbox', { name: 'Timezone' })
  await expect(timezone).toHaveValue('Europe/Berlin')
  await expect(preview).toContainText('At 09:00, Monday through Friday (Europe/Berlin)')

  await pickSchedule(page, dialog, press, 'Daily 09:00')
  await expect(preview).toContainText('At 09:00 (Europe/Berlin)')
  await expect(preview).toContainText(NEXT_RUNS)

  await pickSchedule(page, dialog, press, 'Custom cron')
  const cron = dialog.getByRole('textbox', { name: 'Cron' })
  await expect(cron).toBeFocused()
  await expect(cron).toHaveValue('0 9 * * *')
  await cron.fill('0 9 * *')
  const fields = dialog.getByText('Schedule needs 5 fields: minute hour day-of-month month day-of-week')
  await expect(fields).toHaveClass(/text-destructive/)
  await expect(preview).toHaveCount(0)
  await cron.fill(CRON)
  await timezone.fill('Mars/Olympus')
  await expect(dialog.getByText('Unknown timezone "Mars/Olympus", use an IANA name like Europe/Berlin')).toBeVisible()
  await timezone.fill(TIMEZONE)
  await expect(preview).toContainText(`At 14:30, only on Monday (${TIMEZONE})`)
  await expect(preview).toContainText(NEXT_RUNS)
  if (phone) {
    await expectFitsPhone(page, 'reminder cron editor')
  }
}

/** Switches an existing cron reminder back to every 3 hours. */
async function backToInterval(page: Page, name: string, press: Press): Promise<void> {
  const card = page.getByRole('main').getByRole('region', { name })
  await press(card.getByRole('button', { name: 'Edit', exact: true }))
  const dialog = page.getByRole('dialog', { name: `Edit ${name}` })
  const onCron = dialog.getByRole('switch', { name: 'Cron schedule' })
  await expect(onCron).toBeChecked()
  await expect(dialog.getByRole('combobox', { name: 'Schedule' })).toHaveText('Custom cron')
  await expect(dialog.getByRole('textbox', { name: 'Cron' })).toHaveValue(CRON)
  await expect(dialog.getByRole('textbox', { name: 'Timezone' })).toHaveValue(TIMEZONE)
  await press(onCron)
  await dialog.getByRole('spinbutton', { name: 'Interval' }).fill('3')
  await dialog.getByRole('combobox', { name: 'Interval unit' }).selectOption('hours')
  await press(dialog.getByRole('button', { name: 'Save' }))
  await expect(dialog).toBeHidden()
}

/** Creates a cron reminder, checks its card and API, then edits it back to an interval. */
export async function cronReminderRoundTrip(
  page: Page,
  request: APIRequestContext,
  { press, phone }: { press: Press; phone: boolean },
): Promise<void> {
  const name = `Cron nudge ${randomUUID().slice(0, 8)}`
  const dialog = await openNewReminder(page, press)
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
  await fillCron(page, dialog, press, phone)

  const created = nextApiResponse(page, 'POST', '/channels/reminders')
  await press(dialog.getByRole('button', { name: 'Create' }))
  const info = ((await (await created).json()) as Envelope<ReminderChannelInfo>).data
  await expect(dialog).toBeHidden()
  try {
    expect(info.reminder.schedule).toEqual({ cron: CRON, timezone: TIMEZONE })
    expect(info.reminder.next_run_at).toBe(nextRunTimes(CRON, TIMEZONE, 1)[0])
    const card = page.getByRole('main').getByRole('region', { name })
    const when = await localWhen(page, info.reminder.next_run_at ?? '')
    await expect(card).toContainText(`At 14:30, only on Monday (${TIMEZONE}); next ${when}`)

    await backToInterval(page, name, press)
    await expect(card).toContainText(/Every 3 h; next \w{3}, \w{3} \d+, \d\d:\d\d/)
    await expect(card).not.toContainText(TIMEZONE)
    const saved = await apiData<ReminderChannelInfo>(request, `/channels/reminders/${info.id}`)
    expect(saved.reminder).toMatchObject({ schedule: null, interval_s: 10_800 })
  } finally {
    await request.delete(`/api/channels/${info.id}`)
  }
}
