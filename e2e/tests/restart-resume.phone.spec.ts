import type { Task } from '@seti/shared'
import { SPLIT_NODE } from './support/env.js'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { RESUME_PROMPT, RESUMED_NOTE, startWorkingAgent, transcript } from './support/restart.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a turn a restart cut off shows as resumed on a phone', async ({ page, request, setiServer }) => {
  test.skip(SPLIT_NODE, 'a separate node keeps the turn going across a restart')
  const id = await startWorkingAgent(request)
  await setiServer.restart()

  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page)).toContainText(RESUMED_NOTE)
  await expect(transcript(page)).toContainText(RESUME_PROMPT)
  await expect(transcript(page)).toContainText('Done.')
  await expectFitsPhone(page, 'agent transcript with a resumed turn')
})
