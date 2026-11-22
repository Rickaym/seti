import { addOffServer, allowAndTime, askingForServer, removeServer, requestCard } from './support/ask-server.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const SERVER = 'e2e-ask-phone'

test('on a phone one tap on Allow gives the asking agent the server in its next turn', async ({
  page,
  request,
}, info) => {
  test.setTimeout(180_000)
  await addOffServer(request, SERVER)
  try {
    const task = await askingForServer(request, SERVER)
    await page.goto(`/#agents/${task.id}`)
    await expect(requestCard(page)).toContainText(`+ ${SERVER}`)
    await requestCard(page).scrollIntoViewIfNeeded()
    await expectFitsPhone(page, 'server request')
    const allow = requestCard(page).getByRole('button', { name: 'Allow', exact: true })
    await expectTouchTarget(allow)
    await allowAndTime(page, { task, server: SERVER, tap: true }, info)
  } finally {
    await removeServer(request, SERVER)
  }
})
