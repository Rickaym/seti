import type { Page } from '@playwright/test'
import type { EaHealth } from '@seti/shared'
import { announceDeviceChange, audioSpy, deviceId, spyOnAudio, unplug } from './support/audio.js'
import { fakeEa } from './support/fake-ea.js'
import { expect, test, toasts } from './support/fixtures.js'

test.use({ permissions: ['microphone'] })

const READY: EaHealth = { ok: true, configured: true, missing: [], model: 'gpt-4.1-mini', turn: true }

async function mockEa(page: Page) {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
  return fakeEa(page)
}

/** Chromium's fake media flags always show labels; a real browser shows them once allowed. */
async function hideLabelsUntilAllowed(page: Page) {
  await page.addInitScript(() => {
    const media = navigator.mediaDevices
    const enumerate = media.enumerateDevices.bind(media)
    const getUserMedia = media.getUserMedia.bind(media)
    let allowed = false
    media.enumerateDevices = async () => {
      const devices = await enumerate()
      return allowed
        ? devices
        : devices.map((device) => ({ ...device.toJSON(), deviceId: '', label: '' }) as MediaDeviceInfo)
    }
    media.getUserMedia = async (request) => {
      const stream = await getUserMedia(request)
      allowed = true
      return stream
    }
  })
}

const audioCard = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Audio' })
const eaItem = (page: Page) => page.getByRole('contentinfo').getByRole('group', { name: 'EA', exact: true })
const details = (page: Page) => eaItem(page).getByRole('region', { name: 'EA call' })
const chosen = (page: Page, name: string, scope = audioCard(page)) =>
  scope.getByRole('combobox', { name }).locator('option:checked')

async function startCall(page: Page) {
  await eaItem(page).getByRole('button', { name: 'Start an EA call' }).click()
  await expect(eaItem(page).getByTestId('ea-bar-status')).toHaveText('Listening')
}

test('settings list the devices, keep the choices across a reload and test the speaker', async ({ page }) => {
  await spyOnAudio(page)
  await page.goto('/#settings/ea')
  const card = audioCard(page)
  const mic = card.getByRole('combobox', { name: 'Microphone' })
  await expect(mic.locator('option')).toHaveText(['System default', 'Fake Audio Input 1', 'Fake Audio Input 2'])
  await expect(card.getByRole('combobox', { name: 'Speaker' }).locator('option')).toHaveText([
    'System default',
    'Fake Audio Output 1',
    'Fake Audio Output 2',
  ])
  await expect(chosen(page, 'Microphone')).toHaveText('System default')
  for (const name of ['Cancel echo', 'Denoise', 'Auto gain']) {
    await expect(card.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true')
  }

  await mic.selectOption({ label: 'Fake Audio Input 2' })
  await card.getByRole('combobox', { name: 'Speaker' }).selectOption({ label: 'Fake Audio Output 2' })
  await card.getByRole('button', { name: 'Denoise' }).click()
  await page.reload()
  await expect(chosen(page, 'Microphone')).toHaveText('Fake Audio Input 2')
  await expect(chosen(page, 'Speaker')).toHaveText('Fake Audio Output 2')
  await expect(card.getByRole('button', { name: 'Denoise' })).toHaveAttribute('aria-pressed', 'false')

  const [input, output] = [await deviceId(page, 'Fake Audio Input 2'), await deviceId(page, 'Fake Audio Output 2')]
  await card.getByRole('button', { name: 'Test speaker' }).click()
  await expect.poll(async () => (await audioSpy(page)).tones).toEqual([output])

  const micTest = card.getByRole('button', { name: 'Test mic' })
  await micTest.click()
  await expect(micTest).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(async () => (await audioSpy(page)).requests.at(-1))
    .toEqual({ deviceId: { exact: input }, echoCancellation: true, noiseSuppression: false, autoGainControl: true })
  await micTest.click()
  await expect(micTest).toHaveAttribute('aria-pressed', 'false')
})

test('a call opens the chosen microphone and switches devices mid-call without reconnecting', async ({ page }) => {
  await spyOnAudio(page)
  const { offers } = await mockEa(page)
  await page.goto('/#settings/ea')
  await audioCard(page).getByRole('combobox', { name: 'Microphone' }).selectOption({ label: 'Fake Audio Input 1' })
  const first = await deviceId(page, 'Fake Audio Input 1')
  const second = await deviceId(page, 'Fake Audio Input 2')
  const speaker = await deviceId(page, 'Fake Audio Output 1')

  await startCall(page)
  await expect.poll(async () => (await audioSpy(page)).sent).toEqual([first])

  const card = audioCard(page)
  await card.getByRole('combobox', { name: 'Microphone' }).selectOption({ label: 'Fake Audio Input 2' })
  await expect.poll(async () => (await audioSpy(page)).sent).toEqual([first, second])
  await card.getByRole('combobox', { name: 'Speaker' }).selectOption({ label: 'Fake Audio Output 1' })
  await expect
    .poll(async () => page.getByTestId('ea-audio').evaluate((el) => (el as HTMLAudioElement).sinkId))
    .toBe(speaker)

  const muted = async () => page.getByTestId('ea-audio').evaluate((el) => (el as HTMLAudioElement).muted)
  const mute = card.getByRole('button', { name: 'Mute EA' })
  await mute.click()
  await expect(mute).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(muted).toBe(true)
  await mute.click()
  await expect.poll(muted).toBe(false)

  await audioCard(page).getByRole('button', { name: 'Cancel echo' }).click()
  await expect.poll(async () => (await audioSpy(page)).sent).toEqual([first, second, second])
  expect((await audioSpy(page)).requests.at(-1)).toMatchObject({ echoCancellation: false })
  await expect(eaItem(page).getByTestId('ea-bar-status')).toHaveText('Listening')
  expect(offers).toHaveLength(1)
})

test('a microphone that will not open mid-call leaves the call on the system default', async ({ page }) => {
  await spyOnAudio(page)
  await mockEa(page)
  await page.goto('/#settings/ea')
  const busy = await deviceId(page, 'Fake Audio Input 2')
  await startCall(page)
  await expect.poll(async () => (await audioSpy(page)).sent).toEqual(['default'])
  await page.evaluate((id) => {
    const media = navigator.mediaDevices
    const getUserMedia = media.getUserMedia.bind(media)
    media.getUserMedia = async (request) => {
      const audio = request?.audio
      if (typeof audio === 'object' && JSON.stringify(audio.deviceId ?? '').includes(id)) {
        throw new DOMException('Device in use', 'NotReadableError')
      }
      return getUserMedia(request)
    }
  }, busy)

  await audioCard(page).getByRole('combobox', { name: 'Microphone' }).selectOption({ label: 'Fake Audio Input 2' })
  await expect.poll(async () => (await audioSpy(page)).sent).toEqual(['default', 'default'])
  await expect(eaItem(page).getByTestId('ea-bar-status')).toHaveText('Listening')
})

test('an unplugged device falls back to the system default with one toast', async ({ page }) => {
  await spyOnAudio(page)
  await mockEa(page)
  await page.goto('/#settings/ea')
  const card = audioCard(page)
  await card.getByRole('combobox', { name: 'Microphone' }).selectOption({ label: 'Fake Audio Input 2' })
  await card.getByRole('combobox', { name: 'Speaker' }).selectOption({ label: 'Fake Audio Output 2' })
  const input = await deviceId(page, 'Fake Audio Input 2')
  await startCall(page)
  await expect.poll(async () => (await audioSpy(page)).sent).toEqual([input])

  await unplug(page, input)
  await expect(toasts(page)).toHaveCount(1)
  await expect(toasts(page)).toContainText('Fake Audio Input 2 disconnected. The EA uses the system default now.')
  await expect(chosen(page, 'Microphone')).toHaveText('System default')
  await expect(card.getByTestId('ea-mic-note')).toHaveText(
    'Fake Audio Input 2 is not connected; the system default is used.',
  )
  await expect.poll(async () => (await audioSpy(page)).sent.at(-1)).toBe('default')
  await announceDeviceChange(page)
  await expect(toasts(page)).toHaveCount(1)
  await expect(chosen(page, 'Speaker')).toHaveText('Fake Audio Output 2')
  await expect(eaItem(page).getByTestId('ea-bar-status')).toHaveText('Listening')
})

test('without setSinkId the output picker hides and the system output plays', async ({ page }) => {
  await spyOnAudio(page, { withoutSink: true })
  await mockEa(page)
  await page.goto('/#settings/ea')
  const card = audioCard(page)
  await expect(card.getByRole('combobox', { name: 'Microphone' })).toBeVisible()
  await expect(card.getByRole('combobox', { name: 'Speaker' })).toHaveCount(0)
  await expect(card.getByTestId('ea-speaker-note')).toHaveText('This browser plays the EA on the system output.')
  await card.getByRole('button', { name: 'Test speaker' }).click()
  await expect.poll(async () => (await audioSpy(page)).tones).toEqual(['none'])

  await startCall(page)
  await expect(card.getByRole('combobox', { name: 'Speaker' })).toHaveCount(0)
  await eaItem(page).getByTestId('ea-bar').hover()
  await expect(details(page).getByTestId('ea-status')).toHaveText('Listening')
  await expect(details(page).getByRole('combobox')).toHaveCount(0)
})

test('before the microphone is allowed, the settings ask for it to list devices', async ({ page }) => {
  await hideLabelsUntilAllowed(page)
  await page.goto('/#settings/ea')
  const card = audioCard(page)
  await expect(card.getByTestId('ea-mic-note')).toHaveText('Allow microphone to list devices.')
  await expect(card.getByRole('combobox', { name: 'Microphone' })).toHaveCount(0)
  await card.getByRole('button', { name: 'Allow mic' }).click()
  await expect(card.getByRole('combobox', { name: 'Microphone' }).locator('option')).toHaveCount(3)
  await expect(card.getByTestId('ea-mic-note')).toHaveCount(0)
})
