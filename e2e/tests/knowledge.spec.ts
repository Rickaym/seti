import type { AuditPage, KnowledgeNote } from '@seti/shared'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import { newAgentIndex, proposeAsAgent } from './support/knowledge.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('an agent proposes notes, the user approves one from the Knowledge page and only it reaches agents', async ({
  page,
  request,
}) => {
  const kept = unique('Build before the e2e suite')
  const dropped = unique('Skip the e2e suite')
  const { agent } = await proposeAsAgent(request, kept)
  await proposeAsAgent(request, dropped)
  expect(await apiData<{ status: string }>(request, `/tasks/${agent.id}`)).toMatchObject({
    status: 'idle',
    blocked: null,
  })

  await page.goto('/#agents')
  const context = page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Context', exact: true })
  await expect(context.locator('[data-knowledge-waiting]')).toBeVisible()
  await context.click()
  const notes = page.getByRole('region', { name: 'Knowledge' }).getByRole('button')
  await expect(notes).toContainText('waiting for you')
  await notes.click()
  await expect(page).toHaveURL(/#context\/knowledge:proposed$/)

  const card = page.getByRole('article', { name: `Note: ${kept}` })
  await expect(card).toContainText('run pnpm build before pnpm e2e')
  await expect(card).toContainText('Verify: pnpm build && pnpm e2e smoke')
  await expect(card.getByRole('list', { name: 'Sources' })).toContainText('CONTRIBUTING.md')
  await expect(card).toContainText(`Proposed by ${agent.title}`)

  await card.getByRole('button', { name: 'Edit' }).click()
  await card.getByLabel('Title').fill(`${kept} first`)
  await card.getByRole('button', { name: 'Approve' }).click()
  await expect(toasts(page).filter({ hasText: 'Approved' })).toBeVisible()
  await expect(card).toHaveCount(0)

  await page
    .getByRole('article', { name: `Note: ${dropped}` })
    .getByRole('button', { name: 'Reject' })
    .click()
  await expect(toasts(page).filter({ hasText: 'Rejected' })).toBeVisible()

  await page.getByRole('tab', { name: 'Approved' }).click()
  await expect(page.getByRole('article', { name: `Note: ${kept} first` })).toBeVisible()
  const approved = await apiData<KnowledgeNote[]>(request, '/knowledge?status=approved')
  expect(approved.find((note) => note.title === `${kept} first`)).toMatchObject({ proposer_task_id: agent.id })
  const audit = await apiData<AuditPage>(request, '/audit?kind=context.knowledge_approved&limit=5')
  expect(audit.events.find((event) => event.detail.title === `${kept} first`)).toMatchObject({
    actor: 'user',
    detail: { edited: true },
  })

  const index = await newAgentIndex(request)
  expect(index).toContain('notes other agents wrote and the user approved')
  expect(index).toContain(`${kept} first`)
  expect(index).not.toContain(dropped)
})
