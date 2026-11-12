import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type { AuditPage, EaHealth, EaLlmMessage, EaSettings } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { EA_HEADERS, paths } from './support/env.js'
import { botClosed, botReceived, botSays, fakeEa } from './support/fake-ea.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'

test.use({ permissions: ['microphone'] })

const READY: EaHealth = { ok: true, configured: true, missing: [], model: 'gpt-4.1-mini', turn: true }

async function mockHealth(page: Page, health: EaHealth) {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: health }))
}

async function mockIce(page: Page) {
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
}

const eaItem = (page: Page) => page.getByRole('contentinfo').getByRole('group', { name: 'EA', exact: true })
const details = (page: Page) => eaItem(page).getByRole('region', { name: 'EA call' })

async function saysBot(page: Page, segment: number, text: string) {
  await botSays(page, 'bot-output', {
    text,
    segment_id: segment,
    will_be_spoken: true,
    spoken_progress: { accumulated_text: text, remaining_text: '' },
  })
}

/** An idle task written straight into the database, so no agent turn ever starts. */
async function seedTask(): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.idleTask(id, 'EA composer check', paths.checkout, ts)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Seeded prompt for the EA check.' }), ts)
  await db.close()
  return id
}

test('the EA leads the sidebar as its chat and the status bar as its call', async ({ page }) => {
  await mockHealth(page, READY)
  await page.goto('/#ea')
  await expect(page.getByRole('main').getByRole('heading', { name: 'EA', level: 1 })).toBeVisible()
  const work = page.getByRole('complementary').getByRole('group', { name: 'Work' }).getByRole('button')
  await expect(work).toHaveCount(4)
  await expect(work.first()).toHaveAccessibleName('EA')
  await expect(work.first()).toHaveAttribute('aria-current', 'page')
  await expect(work.nth(1)).toHaveAccessibleName('Home')
  await expect(work.nth(3)).toHaveAccessibleName(/^Questions/)

  const start = page.getByRole('contentinfo').getByRole('button').first()
  await expect(start).toHaveAccessibleName('Start an EA call')
  await expect(start).toHaveText('EA')
  await expect(start).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+E')
  await expect(details(page)).toHaveCount(0)
})

test('a press in the status bar starts a call that the bar mutes and ends on any page', async ({ page }) => {
  await mockHealth(page, READY)
  await mockIce(page)
  const { offers } = await fakeEa(page)
  await page.goto('/#context')
  const item = eaItem(page)
  const status = item.getByTestId('ea-bar-status')

  await item.getByRole('button', { name: 'Start an EA call' }).click()
  await expect(status).toHaveText('Listening')
  const body = offers[0]?.postDataJSON() as { requestData?: { timezone?: string; localTime?: string } }
  expect(body.requestData?.timezone).toBe('Europe/Berlin')
  expect(body.requestData?.localTime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/)
  const playing = async () =>
    page.getByTestId('ea-audio').evaluate((element) => {
      const audio = element as HTMLAudioElement
      const stream = audio.srcObject instanceof MediaStream ? audio.srcObject : null
      return !audio.paused && stream?.getAudioTracks()[0]?.readyState === 'live'
    })
  await expect.poll(playing).toBe(true)

  await botSays(page, 'bot-started-speaking')
  await saysBot(page, 1, 'Good evening.')
  await expect(status).toHaveText('EA speaking')
  await expect(item.getByTestId('ea-bar-caption')).toHaveText('EA: Good evening.')
  await botSays(page, 'bot-stopped-speaking')

  await page.getByRole('complementary').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page).toHaveURL(/#settings$/)
  await item.getByRole('button', { name: 'Mute microphone' }).click()
  await expect(status).toHaveText('Mic muted')
  await expect(item.getByRole('button', { name: 'Unmute microphone' })).toHaveAttribute('aria-pressed', 'true')

  await item.getByRole('button', { name: 'Hang up the EA call' }).click()
  await expect(item.getByRole('button', { name: 'Start an EA call' })).toBeVisible()
  await expect(item.getByTestId('ea-bar')).toHaveCount(0)
  await expect.poll(async () => botClosed(page)).toBe(true)
  expect(offers).toHaveLength(1)
})

test('hovering the bar shows the call state, its level and the call buttons only', async ({ page }) => {
  await mockHealth(page, READY)
  await mockIce(page)
  const { offers } = await fakeEa(page)
  await page.goto('/#agents')
  const item = eaItem(page)
  await item.getByRole('button', { name: 'Start an EA call' }).click()
  await expect(item.getByTestId('ea-bar-status')).toHaveText('Listening')
  await botSays(page, 'user-input', {
    text: 'How is the build?',
    input_type: 'transcription',
    final: false,
    timestamp: '',
  })

  await item.getByTestId('ea-bar').hover()
  const popover = details(page)
  const status = popover.getByTestId('ea-status')
  await expect(status).toHaveText('Listening')
  const names = async () =>
    popover
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent))
  expect(await names()).toEqual(['EA settings', 'Mute', 'Sleep', 'Hang up'])
  await expect(popover).not.toContainText('How is the build?')
  await expect(popover).not.toContainText('gpt-4.1-mini')
  await expect(popover.getByRole('list')).toHaveCount(0)
  await expect(popover.getByRole('combobox')).toHaveCount(0)
  await expect(popover.getByRole('textbox')).toHaveCount(0)

  await botSays(page, 'bot-started-speaking')
  await expect(status).toHaveText('EA speaking')
  await botSays(page, 'bot-stopped-speaking')
  await expect(status).toHaveText('Listening')

  const mute = popover.getByRole('button', { name: 'Mute', exact: true })
  await mute.click()
  await expect(mute).toHaveAttribute('aria-pressed', 'true')
  await expect(status).toHaveText('Mic muted')
  await expect(item.getByTestId('ea-bar-status')).toHaveText('Mic muted')
  await mute.click()
  await expect(status).toHaveText('Listening')

  await popover.getByRole('button', { name: 'Hang up', exact: true }).click()
  await expect(status).toHaveText('Not connected')
  await expect.poll(async () => botClosed(page)).toBe(true)
  await popover.getByRole('button', { name: 'Call', exact: true }).click()
  await expect(status).toHaveText('Listening')
  expect(offers).toHaveLength(2)

  await page.getByRole('main').hover()
  await expect(details(page)).toHaveCount(0)
  await item.getByRole('button', { name: 'Hang up the EA call' }).click()
})

test('the gear in the popover opens Settings, EA and closes the popover', async ({ page }) => {
  await mockHealth(page, READY)
  await page.goto('/#agents')
  await eaItem(page).getByRole('button', { name: 'Start an EA call' }).hover()
  const gear = details(page).getByRole('button', { name: 'EA settings' })
  await gear.hover()
  await expect(page.getByRole('tooltip')).toContainText('Wake word, audio devices, model and relay')
  await gear.click()
  await expect(page).toHaveURL(/#settings\/ea$/)
  await expect(details(page)).toHaveCount(0)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'EA', level: 2, exact: true })).toBeVisible()
  await expect(main.getByRole('group', { name: 'Wake word' })).toBeVisible()
  await expect(main.getByRole('region', { name: 'Audio' }).getByRole('combobox', { name: 'Microphone' })).toBeVisible()
  await expect(main.getByRole('button', { name: 'Test relay' })).toBeVisible()
  await expect(main).toContainText('gpt-4.1-mini')
})

test('the popover never takes focus or keys from the task composer', async ({ page }) => {
  await mockHealth(page, READY)
  const taskId = await seedTask()
  await page.goto(`/#agents/${taskId}`)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await expect(page.getByText('Seeded prompt for the EA check.')).toBeVisible()
  await reply.click()
  await page.keyboard.type('Hello')

  await eaItem(page).getByRole('button', { name: 'Start an EA call' }).hover()
  await expect(details(page)).toBeVisible()
  await page.keyboard.type(' there')
  await expect(reply).toBeFocused()
  await expect(reply).toHaveValue('Hello there')
  await expect(details(page)).toBeVisible()
})

test('Ctrl+Shift+E starts and ends a call, one offer per call', async ({ page }) => {
  await mockHealth(page, READY)
  await mockIce(page)
  const { offers } = await fakeEa(page)
  await page.goto('/#agents')
  const item = eaItem(page)

  for (const count of [1, 2]) {
    await page.keyboard.press('Control+Shift+E')
    await expect(item.getByTestId('ea-bar-status')).toHaveText('Listening')
    await page.keyboard.press('Control+Shift+E')
    await expect(item.getByRole('button', { name: 'Start an EA call' })).toBeVisible()
    expect(offers).toHaveLength(count)
  }
})

test('the details stay open while the pointer is inside them', async ({ page }) => {
  await page.clock.install()
  await mockHealth(page, READY)
  await page.goto('/#agents')
  const start = eaItem(page).getByRole('button', { name: 'Start an EA call' })
  await start.hover()
  await page.clock.runFor(300)
  await expect(details(page)).toBeVisible()

  const box = await details(page).boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(40, (box?.y ?? 0) + (box?.height ?? 0) - 20, { steps: 8 })
  await page.clock.runFor(1000)
  await expect(details(page)).toBeVisible()

  await page.getByRole('main').hover()
  await page.clock.runFor(1000)
  await expect(details(page)).toHaveCount(0)
})

test('keyboard focus opens the details, and Esc closes them', async ({ page }) => {
  await mockHealth(page, READY)
  await page.goto('/#agents')
  const start = eaItem(page).getByRole('button', { name: 'Start an EA call' })
  await expect(start).toBeVisible()
  for (let presses = 0; presses < 60 && !(await start.evaluate((el) => el === document.activeElement)); presses += 1) {
    await page.keyboard.press('Tab')
  }
  await expect(start).toBeFocused()
  await expect(details(page)).toBeVisible()
  await expect(details(page).getByTestId('ea-status')).toHaveText('Not connected')
  await expect(details(page).getByRole('button', { name: 'Call', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(details(page)).toHaveCount(0)
  await expect(start).toBeFocused()
})

test('missing keys turn the item into a setup warning that leads to the settings', async ({ page }) => {
  await page.clock.install()
  await mockHealth(page, { ...READY, configured: false, missing: ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY'] })
  const offers: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/api/ea/offer')) {
      offers.push(request.method())
    }
  })
  await page.goto('/#agents')
  const warning = eaItem(page).getByRole('button', { name: 'EA needs setup' })
  await expect(warning).toHaveAttribute('data-look', 'setup')

  await warning.click()
  await expect(warning).toHaveAttribute('aria-expanded', 'true')
  const notice = details(page).getByRole('status')
  await expect(notice).toHaveText('The EA needs a few keys. Set it up')
  await expect(details(page).getByRole('button', { name: 'Call', exact: true })).toBeDisabled()
  await page.getByRole('main').hover()
  await page.clock.runFor(1000)
  await expect(notice).toBeVisible()

  await page.getByRole('main').click({ position: { x: 5, y: 5 } })
  await expect(details(page)).toHaveCount(0)
  await page.keyboard.press('Control+Shift+E')
  await expect(notice).toBeVisible()
  expect(offers).toEqual([])

  await notice.getByRole('button', { name: 'Set it up' }).click()
  await expect(page).toHaveURL(/#settings\/ea$/)
  await expect(details(page)).toHaveCount(0)
  const setup = page.getByRole('main').getByRole('region', { name: 'EA setup' })
  await expect(setup).toContainText('The EA needs a few keys')
  await expect(setup).toContainText('~/.seti/credentials')
  await expect(setup.locator('pre').first()).toHaveText(
    '~/.seti/credentials/openai-api-key\n~/.seti/credentials/elevenlabs-api-key',
  )
  await expect(setup).toContainText('systemctl --user restart seti-ea.service')
})

test('a bot that is not running says so, and the settings show how to start the service', async ({ page }) => {
  await page.goto('/#agents')
  const warning = eaItem(page).getByRole('button', { name: 'EA needs setup' })
  await warning.hover()
  const notice = details(page).getByRole('status')
  await expect(notice).toContainText('The EA is not running.')
  await notice.getByRole('button', { name: 'Set it up' }).click()
  const setup = page.getByRole('main').getByRole('region', { name: 'EA setup' })
  await expect(setup).toContainText('Nothing answers at')
  await expect(setup).toContainText('systemctl --user enable --now seti-ea.service')
})

test.describe('with the bot gone after the health check', () => {
  test.use({ allowedHttpStatuses: [503] })

  test('a failed start toasts the reason and the details keep it', async ({ page }) => {
    await mockHealth(page, READY)
    await page.route('**/api/ea/ice', async (route) =>
      route.fulfill({ status: 503, json: { error: { title: 'EA is not running', detail: 'bot stopped' } } }),
    )
    await page.goto('/#context')
    const start = eaItem(page).getByRole('button', { name: 'Start an EA call' })
    await start.click()
    const toast = toasts(page).filter({ hasText: 'The EA call could not start' })
    await expect(toast).toContainText('EA is not running: bot stopped')
    await expect(start).toHaveAttribute('data-look', 'failed')

    await start.hover()
    await expect(details(page).getByTestId('ea-status')).toHaveText('Call failed')
    await expect(details(page)).toContainText('EA is not running: bot stopped')
  })
})

test('actions the EA takes are marked in the audit log', async ({ page, request }) => {
  const name = unique('spoken-pack')
  const created = await request.post('/api/context/packs', {
    headers: EA_HEADERS,
    data: { name, body: 'Asked for by voice' },
  })
  expect(created.ok()).toBe(true)
  await page.goto('/#settings/audit')
  const row = page.getByRole('main').getByRole('row').filter({ hasText: name })
  const mark = row.getByRole('img', { name: 'Asked through the EA voice assistant' })
  await expect(mark).toBeVisible()
  await expect(row.locator('[data-via="ea"]')).toHaveAttribute('title', 'Asked through the EA voice assistant')
})

const BOT = EA_HEADERS
const WAKE_OFF = { wake_enabled: false, wake_phrase: 'Hey Seti', keep_awake_seconds: 30 }

async function storeTurns(request: APIRequestContext, entries: { kind: 'message' | 'call'; message: EaLlmMessage }[]) {
  const response = await request.post('/api/ea/history/messages', { headers: BOT, data: { entries } })
  expect(response.ok(), 'POST /api/ea/history/messages').toBe(true)
  return ((await response.json()) as { data: { ids: number[] } }).data.ids
}

const said = (content: string) => ({ kind: 'message' as const, message: { role: 'user' as const, content } })
const answered = (content: string) => ({ kind: 'message' as const, message: { role: 'assistant' as const, content } })
const callStarted = { kind: 'call' as const, message: { role: 'developer' as const, content: 'A new call started.' } }

test.describe('the EA conversation and wake word', () => {
  test.beforeEach(async ({ request }) => {
    expect((await request.delete('/api/ea/history')).ok()).toBe(true)
    expect((await request.put('/api/ea/settings', { data: WAKE_OFF })).ok()).toBe(true)
  })

  test.afterEach(async ({ request }) => {
    await request.delete('/api/ea/history')
    await request.put('/api/ea/settings', { data: WAKE_OFF })
  })

  test('the EA chat shows what a call stores while it runs and once it ends', async ({ page, request }) => {
    await storeTurns(request, [callStarted, said('Earlier question?'), answered('Earlier answer.')])
    await mockHealth(page, READY)
    await mockIce(page)
    await fakeEa(page)
    await page.goto('/#ea')
    const transcript = page.getByRole('main').getByRole('region', { name: 'Transcript' })
    await expect(transcript).toContainText('Earlier answer.')

    const item = eaItem(page)
    await item.getByRole('button', { name: 'Start an EA call' }).click()
    await expect(item.getByTestId('ea-bar-status')).toHaveText('Listening')
    const card = page.getByRole('main').getByRole('region', { name: 'Live call' })
    await expect(card.getByTestId('ea-call-status')).toHaveText('Listening')
    await storeTurns(request, [callStarted, said('Live question?')])
    await expect(transcript).toContainText('Live question?')

    await item.getByRole('button', { name: 'Hang up the EA call' }).click()
    await expect(card).toHaveCount(0)
    await storeTurns(request, [answered('Live answer.')])
    await expect(transcript).toContainText('Live answer.')
  })

  test('the wake word set in settings reaches a live call, and Sleep in the popover rests the EA', async ({
    page,
    request,
  }) => {
    await mockHealth(page, READY)
    await mockIce(page)
    await fakeEa(page)
    await page.goto('/#settings/ea')
    const item = eaItem(page)
    await item.getByRole('button', { name: 'Start an EA call' }).click()
    const status = item.getByTestId('ea-bar-status')
    await expect(status).toHaveText('Listening')

    const wake = page.getByRole('main').getByRole('group', { name: 'Wake word' })
    const toggle = wake.getByRole('button', { name: 'Wake word' })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await apiData<EaSettings>(request, '/ea/settings')).wake_enabled).toBe(true)
    await expect.poll(async () => botReceived(page)).toEqual(['ea-settings-changed'])

    const phrase = wake.getByRole('textbox', { name: 'Wake phrase' })
    await phrase.fill('hey <seti>')
    await phrase.press('Enter')
    await expect(wake.getByRole('alert')).toContainText('Use letters, digits, spaces')
    await phrase.fill('OK Computer')
    await phrase.press('Enter')
    await expect(wake.getByRole('alert')).toHaveCount(0)
    await expect.poll(async () => (await apiData<EaSettings>(request, '/ea/settings')).wake_phrase).toBe('OK Computer')
    await expect.poll(async () => botReceived(page)).toEqual(['ea-settings-changed', 'ea-settings-changed'])
    const audit = await apiData<AuditPage>(request, '/audit?kind=ea.settings_changed&limit=1')
    expect(audit.events[0]).toMatchObject({ summary: 'EA wake word on, "OK Computer"' })

    await botSays(page, 'server-message', { type: 'ea-wake', enabled: true, awake: false, phrase: 'OK Computer' })
    await expect(status).toHaveText('Say "OK Computer"')
    await expect(item.getByTestId('ea-light')).toHaveAttribute('data-wake', 'asleep')
    await item.getByTestId('ea-bar').hover()
    await expect(details(page).getByTestId('ea-status')).toHaveText('Asleep')
    await expect(details(page)).toContainText('Say "OK Computer" to wake it')
    await botSays(page, 'server-message', { type: 'ea-wake', enabled: true, awake: true, phrase: 'OK Computer' })
    await expect(status).toHaveText('Listening')
    await expect(item.getByTestId('ea-light')).toHaveAttribute('data-wake', 'awake')

    const sleep = details(page).getByRole('button', { name: 'Sleep', exact: true })
    await sleep.click()
    await expect.poll(async () => botReceived(page)).toEqual(['ea-settings-changed', 'ea-settings-changed', 'ea-sleep'])
    await botSays(page, 'server-message', {
      type: 'ea-wake',
      enabled: true,
      awake: false,
      phrase: 'OK Computer',
      local: true,
    })
    await expect(sleep).toHaveAttribute('aria-pressed', 'true')
    await expect(details(page).getByTestId('ea-local-hint')).toHaveText(
      'Listening locally: no speech to text until the phrase',
    )
    await sleep.click()
    await expect
      .poll(async () => botReceived(page))
      .toEqual(['ea-settings-changed', 'ea-settings-changed', 'ea-sleep', 'ea-wake-up'])

    await item.getByRole('button', { name: 'Hang up the EA call' }).click()
  })
})
