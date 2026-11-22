import { randomUUID } from 'node:crypto'
import type { SetiControlLevel } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { tasks } from '../db.js'
import { auditEvents } from '../store/audit.js'
import { SETI_TOOLS } from './catalog.js'
import { toolsFor } from './levels.js'
import { callSetiTool } from './server.js'

async function newTask(title: string, setiControl: SetiControlLevel): Promise<string> {
  const id = randomUUID()
  await tasks.insert({ id, title, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [], seti_control: setiControl })
  return id
}

async function call(callerId: string, name: string, args: object = {}) {
  const entry = SETI_TOOLS.find((tool) => tool.name === name)
  if (entry === undefined) {
    throw new Error(`No seti tool ${name}`)
  }
  const result = await callSetiTool(entry, callerId, args)
  const text = result.content.map((block) => block.text).join('')
  return { error: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> }
}

const DROP_DEPLOYS = "export default (e) => e.event !== 'deploy'"

describe('webhook filter seti tools', () => {
  it('lets an agent at Full write, read, test, switch and remove a filter, audited as the agent', async () => {
    const caller = await newTask('Filter keeper', 'full')
    await call(caller, 'create_channel', { name: 'Filtered hook', subscribe_ea: false })

    const set = await call(caller, 'update_channel', { channel: 'Filtered hook', filter: DROP_DEPLOYS })
    expect(set.json().filter).toMatchObject({ enabled: true, failures_in_a_row: 0, code: DROP_DEPLOYS })
    const audited = await auditEvents.latest('system.webhook_filter_changed')
    expect(audited).toMatchObject({ actor: 'agent', detail: { agent_id: caller, enabled: true } })
    expect(JSON.stringify(audited)).not.toContain('deploy')

    const read = await call(caller, 'get_channel', { channel: 'Filtered hook' })
    expect(read.json().filter).toMatchObject({ code: DROP_DEPLOYS })

    const tested = await call(caller, 'test_channel_script', {
      channel: 'Filtered hook',
      sample: JSON.stringify({ kind: 'deploy', title: 'Shipped' }),
    })
    expect(tested.json()).toMatchObject({
      rows: [{ source: 'sample', event: 'deploy', outcome: 'dropped' }],
      sample_error: null,
    })
    const draft = await call(caller, 'test_channel_script', {
      channel: 'Filtered hook',
      script: 'export default () => 42',
      sample: JSON.stringify({ kind: 'deploy', title: 'Shipped' }),
    })
    expect(draft.json()).toMatchObject({ rows: [{ outcome: 'failed' }] })

    const off = await call(caller, 'update_channel', { channel: 'Filtered hook', filter_enabled: false })
    expect(off.json().filter).toMatchObject({ enabled: false, code: DROP_DEPLOYS })
    const same = await call(caller, 'update_channel', { channel: 'Filtered hook', filter_enabled: false })
    expect(same).toMatchObject({ error: true, text: 'That changes nothing in the webhook Filtered hook.' })
    const removed = await call(caller, 'update_channel', { channel: 'Filtered hook', filter: '' })
    expect(removed.json().filter).toBeNull()
    await call(caller, 'delete_channel', { channel: 'Filtered hook' })
  })

  it('refuses a filter on a reminder and gives agents below Full no tool that writes one', async () => {
    const caller = await newTask('Reminder filter', 'full')
    await call(caller, 'create_reminder', {
      name: 'Filterless',
      script: "export default () => 'x'",
      interval_minutes: 30,
    })
    expect(await call(caller, 'update_channel', { channel: 'Filterless', filter: DROP_DEPLOYS })).toMatchObject({
      error: true,
      text: 'Only webhooks take a filter.',
    })
    await call(caller, 'delete_channel', { channel: 'Filterless' })

    const names = (level: SetiControlLevel) => toolsFor(level).map((tool) => tool.name)
    expect(names('full')).toContain('update_channel')
    expect(names('self')).not.toContain('update_channel')
    expect(names('self')).not.toContain('test_channel_script')
  })
})
