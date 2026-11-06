import { randomUUID } from 'node:crypto'
import { nextRunTimes, type SetiControlLevel } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { tasks } from '../db.js'
import { SETI_TOOLS } from './catalog.js'
import { callSetiTool } from './server.js'
import { createPoller } from '../pollers/actions.js'
import { auditEvents } from '../store/audit.js'
import { channelStore } from '../store/channels.js'
import { keyConnection } from '../test-connections.js'

async function newTask(title: string, setiControl: SetiControlLevel): Promise<string> {
  const id = randomUUID()
  await tasks.insert({
    id,
    title,
    repo_id: null,
    cwd: '/tmp',
    worktree: false,
    pr_urls: [],
    seti_control: setiControl,
  })
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

describe('channel seti tools', () => {
  it('creates, subscribes, lists and deletes a webhook without ever showing its secret', async () => {
    const caller = await newTask('Channel keeper', 'full')
    const created = await call(caller, 'create_channel', { name: 'Agent uptime', subscribe_ea: true })
    expect(created.error).toBe(false)
    const channel = created.json()
    const stored = await channelStore.get(String(channel.id))
    expect(stored?.secret).toBeTruthy()
    expect(created.text).not.toContain(String(stored?.secret))
    expect(channel.secret).toBe(
      'Its secret waits for the user, who copies it once from Settings, Channels into the sender.',
    )

    const subscribed = await call(caller, 'subscribe_channel', {
      channel: 'Agent uptime',
      subscriber: 'Channel keeper',
      events: ['incident'],
    })
    expect(subscribed.json()).toMatchObject({ target: 'task', task_id: caller, events: ['incident'] })

    const listed = await call(caller, 'list_channels')
    const entry = (JSON.parse(listed.text) as { name: string; subscribers: { target: string }[] }[]).find(
      (c) => c.name === 'Agent uptime',
    )
    expect(entry?.subscribers.map((s) => s.target).sort()).toEqual(['ea', 'task'])

    const rotated = await call(caller, 'rotate_channel_secret', { channel: 'Agent uptime' })
    const after = await channelStore.get(String(channel.id))
    expect(after?.secret).not.toBe(stored?.secret)
    expect(rotated.text).not.toContain(String(after?.secret))

    expect((await call(caller, 'unsubscribe_channel', { channel: 'Agent uptime', subscriber: 'ea' })).error).toBe(false)
    expect((await call(caller, 'delete_channel', { channel: 'Agent uptime' })).error).toBe(false)
    expect(await channelStore.get(String(channel.id))).toBeUndefined()

    const audited = await auditEvents.page({ kind: 'system.channel_created', limit: 20 })
    expect(audited.events.find((e) => e.subject_id === channel.id)).toMatchObject({
      actor: 'agent',
      detail: { agent_id: caller },
    })
  })

  it('refuses what the EA cannot do with a poller that uses secrets, and works for no agent without control', async () => {
    const caller = await newTask('Poller keeper', 'full')
    await keyConnection('agent_tool_token', 'x'.repeat(24))
    await createPoller({
      name: 'Secret feed',
      script: 'export default () => []',
      preset: 'blank',
      interval_s: 300,
      timeout_s: 30,
      extra_hosts: [],
      secrets: ['agent_tool_token'],
      fingerprint_fields: [],
      detect_gone: false,
      enabled: false,
      subscribe_ea: false,
    })
    const rewrite = await call(caller, 'update_poller', { poller: 'Secret feed', script: 'export default () => [1]' })
    expect(rewrite).toMatchObject({
      error: true,
      text: 'Agents cannot change the script of a poller that uses secrets; only the user does that, in Seti',
    })
    const paused = await call(caller, 'update_poller', { poller: 'Secret feed', interval_minutes: 15 })
    expect(paused.json()).toMatchObject({ interval_s: 900, secrets: ['agent_tool_token'] })

    const outsider = await newTask('No control', 'off')
    expect((await call(outsider, 'list_channels')).error).toBe(true)
    await call(caller, 'delete_channel', { channel: 'Secret feed' })
  })

  it('creates, tests, changes, pauses, runs and deletes a reminder', async () => {
    const caller = await newTask('Reminder keeper', 'full')
    const script = "export default ({ state }) => ({ message: 'Nudge ' + ((state ?? 0) + 1), state: (state ?? 0) + 1 })"
    const draft = await call(caller, 'test_channel_script', { script, kind: 'reminder' })
    expect(draft.json()).toMatchObject({ outcome: 'ok', message: 'Nudge 1', state: 1 })
    expect((await call(caller, 'test_channel_script', { script })).error).toBe(true)

    const created = await call(caller, 'create_reminder', { name: 'Agent nudge', script, interval_minutes: 30 })
    expect(created.json()).toMatchObject({ source: 'reminder', interval_s: 1800, status: 'pending' })
    const ran = await call(caller, 'run_channel', { channel: 'Agent nudge' })
    expect(ran.json()).toMatchObject({ latest_runs: [{ outcome: 'ok', message: 'Nudge 1' }] })
    const saved = await call(caller, 'test_channel_script', { channel: 'Agent nudge' })
    expect(saved.json()).toMatchObject({ message: 'Nudge 2' })

    const paused = await call(caller, 'update_channel', { channel: 'Agent nudge', active: false, interval_minutes: 60 })
    expect(paused.json()).toMatchObject({ enabled: false, status: 'paused', interval_s: 3600, next_run_at: null })
    const same = await call(caller, 'update_channel', { channel: 'Agent nudge', active: false })
    expect(same).toMatchObject({ error: true, text: 'That changes nothing in the reminder Agent nudge.' })
    const history = await call(caller, 'get_channel', { channel: 'Agent nudge', runs: true })
    expect(JSON.parse(history.text)).toMatchObject([{ trigger: 'manual', outcome: 'ok' }])
    const webhookOnly = await call(caller, 'test_channel', { channel: 'Agent nudge' })
    expect(webhookOnly).toMatchObject({
      error: true,
      text: 'Agent nudge is a reminder, not a webhook: use update_channel, run_channel or test_channel_script.',
    })
    expect((await call(caller, 'delete_channel', { channel: 'Agent nudge' })).text).toContain(
      'Deleted the reminder Agent nudge.',
    )
  })

  it('runs a reminder on a cron schedule in a timezone and goes back to the interval', async () => {
    const caller = await newTask('Cron keeper', 'full')
    const script = "export default () => 'Standup'"
    const create = async (args: object) => call(caller, 'create_reminder', { name: 'Standup', script, ...args })
    expect(await create({ timezone: 'UTC' })).toMatchObject({
      error: true,
      text: 'Give a cron schedule with the timezone.',
    })
    expect(await create({ cron: '61 * * * *' })).toMatchObject({
      error: true,
      text: 'schedule.cron: Invalid schedule: Invalid value for minute: 61',
    })
    const created = (await create({ cron: '0 9 * * 1-5', timezone: 'Europe/Berlin' })).json()
    expect(created).toMatchObject({ schedule: { cron: '0 9 * * 1-5', timezone: 'Europe/Berlin' }, status: 'pending' })
    expect(created.next_run_at).toBe(nextRunTimes('0 9 * * 1-5', 'Europe/Berlin', 1)[0])
    const made = await auditEvents.latest('system.channel_created')
    expect(made).toMatchObject({ subject_id: created.id, detail: { cron: '0 9 * * 1-5 (Europe/Berlin)' } })

    const update = async (args: object) => call(caller, 'update_channel', { channel: 'Standup', ...args })
    expect((await update({ cron: '30 8 * * *' })).json()).toMatchObject({
      schedule: { cron: '30 8 * * *', timezone: 'Europe/Berlin' },
    })
    const utc = (await update({ timezone: 'UTC' })).json()
    expect(utc).toMatchObject({ schedule: { cron: '30 8 * * *', timezone: 'UTC' } })
    expect(utc.next_run_at).toBe(nextRunTimes('30 8 * * *', 'UTC', 1)[0])
    expect((await auditEvents.latest('system.channel_changed'))?.summary).toBe('Changed the reminder Standup: schedule')

    const before = Date.now()
    const back = (await update({ cron: '' })).json()
    expect(back).toMatchObject({ schedule: null, interval_s: 3600 })
    expect(Date.parse(String(back.next_run_at)) - before).toBeGreaterThanOrEqual(3600_000 - 1000)
    expect(await update({ cron: '' })).toMatchObject({
      error: true,
      text: 'That changes nothing in the reminder Standup.',
    })
    await call(caller, 'create_channel', { name: 'Plain hook', subscribe_ea: false })
    expect(await call(caller, 'update_channel', { channel: 'Plain hook', cron: '0 9 * * *' })).toMatchObject({
      error: true,
      text: 'Only reminders take a script, an interval, a cron schedule or active.',
    })
    await call(caller, 'delete_channel', { channel: 'Plain hook' })
    await call(caller, 'delete_channel', { channel: 'Standup' })
  })
})
