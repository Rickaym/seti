import { expect, test } from './support/fixtures.js'
import { expectNotice, expectSettingsFallback, startFallbackAgent, switchBack } from './support/model-fallback.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('on a phone the fallback notice, its mark and Switch back work end to end', async ({ page, request }) => {
  const { id, release } = await startFallbackAgent(page, request)
  const notice = await expectNotice(page)
  const mark = page.getByTestId('agent-header').getByTestId('fallback-mark')
  await expect(mark).toBeVisible()

  const button = notice.getByRole('button', { name: 'Switch back' })
  await expect(button).toBeDisabled()
  release()
  await expect(button).toBeEnabled()

  await expectSettingsFallback(page)
  await switchBack(page, request, id, mark)
})
