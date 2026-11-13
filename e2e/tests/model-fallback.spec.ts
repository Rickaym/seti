import { expect, test } from './support/fixtures.js'
import {
  expectNotice,
  expectSettingsFallback,
  fallbackNotice,
  startFallbackAgent,
  switchBack,
} from './support/model-fallback.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a safeguard fallback shows a notice and a Fallback mark until Switch back takes effect', async ({
  page,
  request,
}) => {
  const { id, release } = await startFallbackAgent(page, request)
  const notice = await expectNotice(page)
  const mark = page.getByRole('main').getByTestId('fallback-mark')
  await expect(mark).toBeVisible()
  await mark.hover()
  await expect(page.getByRole('tooltip')).toHaveText(
    'On Opus 4.8 since a cyber safeguard flagged a request; Switch back returns it to Opus 5.5',
  )

  const button = notice.getByRole('button', { name: 'Switch back' })
  await expect(button).toBeDisabled()
  await expect(notice).toContainText('after this turn')
  release()
  await expect(button).toBeEnabled()
  await expect(fallbackNotice(page)).not.toContainText('after this turn')

  await expectSettingsFallback(page)
  await switchBack(page, request, id, mark)
})
