import {
  channelCreateInput,
  channelUpdateInput,
  REMINDER_API_DOC,
  reminderUpdateInput,
  CORE_WEBHOOK_SOURCE,
  type ChannelInfo,
  type ReminderChannelInfo,
} from '@seti/shared'
import { z } from 'zod'
import { channelRef, existingSubscription, findChannel, findWebhook, webhookRef } from './channel-refs.js'
import { subscribeChannelTool, unsubscribeChannelTool } from './channel-subscribe.js'
import { POLLER_TOOLS, pollerRunView, pollerView, testPollerScript } from './pollers.js'
import {
  REMINDER_TOOLS,
  reminderChange,
  reminderCron,
  reminderMinutes,
  reminderRunView,
  reminderScript,
  reminderTimezone,
  reminderView,
  testReminderScript,
} from './reminders.js'
import { done, setiTool, ToolRefusal, type SetiTool } from './tool.js'
import { upcomingView } from './upcoming.js'
import { deliveryView, webhookView } from './webhook-view.js'
import {
  createChannel,
  deleteChannel,
  listChannels,
  rotateChannel,
  subscribeChannel,
  unsubscribeChannel,
  updateChannel,
} from '../channels/actions.js'
import { webhooks } from '../channels/service.js'
import { channelSources } from '../channels/source-info.js'
import { pollNow } from '../pollers/actions.js'
import { pollers } from '../pollers/service.js'
import { runReminderNow, updateReminder } from '../reminders/actions.js'
import { reminders } from '../reminders/service.js'

function channelView(info: ChannelInfo, shown?: number) {
  if (info.source === 'poller') {
    return pollerView(info, false)
  }
  return info.source === 'reminder' ? reminderView(info, false) : webhookView(info, shown)
}

const listChannelsTool = setiTool({
  name: 'list_channels',
  description:
    "List the channels that report to the EA's inbox or to agents: webhooks that senders such as uptime " +
    'monitors, GitHub or Sentry post to, pollers Seti runs for services without webhooks, and reminders ' +
    'whose script Seti runs on an interval or cron schedule, with their subscribers and latest events. ' +
    'With upcoming, what is scheduled next instead: the coming runs of every poller and reminder.',
  input: {
    upcoming: z
      .boolean()
      .optional()
      .describe('Show only the next runs of pollers and reminders, soonest first, and which are paused.'),
  },
  run: async ({ upcoming }) => {
    const channels = await listChannels()
    return upcoming === true ? upcomingView(channels) : channels.map((info) => channelView(info, 1))
  },
})

const RUNS_SHOWN = 10

const getChannel = setiTool({
  name: 'get_channel',
  description:
    "One channel in detail: a webhook's URL, which header it signs with, its secret's state (never the " +
    'secret), field mapping, subscribers with their event filters, and recent events and deliveries with ' +
    "where each went; a poller's or reminder's status, schedule, reach, script and latest runs. With runs, " +
    "only a poller's or reminder's latest runs in full, with their logs.",
  input: {
    channel: channelRef,
    runs: z.boolean().optional().describe('Pollers and reminders: show only the latest runs, with their logs.'),
  },
  run: async ({ channel, runs }) => {
    const info = await findChannel(channel)
    if (info.source === 'poller') {
      return runs === true ? (await pollers.runs(info.id, RUNS_SHOWN)).map(pollerRunView) : pollerView(info)
    }
    if (info.source === 'reminder') {
      return runs === true ? (await reminders.runs(info.id, RUNS_SHOWN)).map(reminderRunView) : reminderView(info)
    }
    if (runs === true) {
      throw new ToolRefusal(`${info.name} is a webhook; its deliveries show without runs.`)
    }
    return webhookView(info)
  },
})

const mappingInput = channelCreateInput.shape.mapping.describe(
  'Generic webhooks only: JSON pointers saying where the payload keeps title, kind, severity, url, ' +
    'subject and state, such as {"title": "/alert/name"}.',
)

function checkMapping(preset: string, mapping: object | undefined): void {
  if (mapping !== undefined && Object.keys(mapping).length > 0 && preset !== CORE_WEBHOOK_SOURCE) {
    throw new ToolRefusal('Only generic webhooks take a field mapping.')
  }
}

/** A source as the caller named it: its id, its label or the id within its mod, such as github. */
function sourceIdOf(given: string): string {
  const wanted = given.trim().toLowerCase()
  const match = channelSources().webhooks.find(
    ({ id, label }) => id === wanted || label.toLowerCase() === wanted || id.split('.').at(-1) === wanted,
  )
  return match?.id ?? given
}

const sourcesWords = () =>
  channelSources()
    .webhooks.map(({ id, label }) => `${label} (${id})`)
    .join(', ')

const createChannelTool = setiTool({
  name: 'create_channel',
  description:
    'Create a webhook channel. Seti issues its signing secret, which only the user sees, once, in Settings; ' +
    "for Sentry the user pastes the secret Sentry issues. Its events reach the EA's inbox only with " +
    'subscribe_ea; subscribe agents to it with subscribe_channel.',
  input: {
    name: channelCreateInput.shape.name,
    preset: z
      .string()
      .trim()
      .min(1)
      .max(82)
      .default(CORE_WEBHOOK_SOURCE)
      .describe(
        'The kind of sender: generic for any JSON sender (the default), or a webhook source by its id or ' +
          'name, such as GitHub or Sentry, while the mod that adds it is on.',
      ),
    subscribe_ea: channelCreateInput.shape.subscribe_ea,
    mapping: mappingInput,
  },
  run: async (args) => {
    const parsed = channelCreateInput.safeParse({ ...args, preset: sourceIdOf(args.preset) })
    if (!parsed.success) {
      throw new ToolRefusal(`Seti takes no webhook source ${args.preset}; it takes ${sourcesWords()}.`)
    }
    checkMapping(parsed.data.preset, args.mapping)
    const created = await createChannel(parsed.data)
    return webhookView(created.channel)
  },
})

/** Subscribes or unsubscribes the EA's inbox; true when that changed anything. */
async function toggleEa(info: ChannelInfo, subscribeEa: boolean | undefined): Promise<boolean> {
  const ea = existingSubscription(info, { target: 'ea' })
  if (subscribeEa === undefined || subscribeEa === (ea !== undefined)) {
    return false
  }
  if (subscribeEa) {
    await subscribeChannel(info.id, { target: 'ea', events: null, mode: 'report' })
  } else if (ea !== undefined) {
    await unsubscribeChannel(info.id, ea.id)
  }
  return true
}

interface ReminderUpdateArgs {
  name?: string | undefined
  subscribe_ea?: boolean | undefined
  script?: string | undefined
  interval_minutes?: number | undefined
  cron?: string | undefined
  timezone?: string | undefined
  active?: boolean | undefined
}

async function updateReminderChannel(info: ReminderChannelInfo, args: ReminderUpdateArgs) {
  const change = reminderChange(info, { ...args, minutes: args.interval_minutes })
  const changed = Object.keys(change).length > 0
  const toggled = await toggleEa(info, args.subscribe_ea)
  if (!changed && !toggled) {
    throw new ToolRefusal(`That changes nothing in the reminder ${info.name}.`)
  }
  if (changed) {
    await updateReminder(info.id, reminderUpdateInput.parse(change))
  }
  return reminderView(await reminders.info(info.id))
}

const updateInput = {
  channel: z.string().trim().min(1).describe("The webhook's or reminder's name or id."),
  name: channelCreateInput.shape.name.optional(),
  subscribe_ea: z.boolean().optional().describe("true sends its events to the EA's inbox, false stops that."),
  mapping: channelUpdateInput.shape.mapping.describe('Replaces the whole mapping; generic webhooks only.'),
  script: reminderScript.optional().describe(`Reminders only: the whole new script. ${REMINDER_API_DOC}`),
  interval_minutes: reminderMinutes,
  cron: reminderCron,
  timezone: reminderTimezone,
  active: z.boolean().optional().describe('Reminders only: false pauses it, true resumes it.'),
}

const updateChannelTool = setiTool({
  name: 'update_channel',
  description:
    "Rename a webhook or reminder, subscribe or unsubscribe the EA's inbox, replace a generic webhook's " +
    "field mapping, or change a reminder's script, interval or cron schedule and pause or resume it. Pollers change with " +
    'update_poller.',
  input: updateInput,
  run: async (args) => {
    const found = await findChannel(args.channel)
    if (found.source === 'reminder') {
      return updateReminderChannel(found, args)
    }
    const info = await findWebhook(args.channel)
    const reminderOnly = [args.script, args.interval_minutes, args.cron, args.timezone, args.active]
    if (reminderOnly.some((value) => value !== undefined)) {
      throw new ToolRefusal('Only reminders take a script, an interval, a cron schedule or active.')
    }
    const { name, mapping } = args
    checkMapping(info.preset, mapping)
    const change = {
      ...(name === undefined || name === info.name ? {} : { name }),
      ...(mapping === undefined || JSON.stringify(mapping) === JSON.stringify(info.mapping) ? {} : { mapping }),
    }
    if (Object.keys(change).length > 0) {
      await updateChannel(info.id, channelUpdateInput.parse(change))
    }
    if (!(await toggleEa(info, args.subscribe_ea)) && Object.keys(change).length === 0) {
      throw new ToolRefusal(`That changes nothing in the webhook ${info.name}.`)
    }
    return webhookView(await webhooks.info(info.id))
  },
})

const runChannel = setiTool({
  name: 'run_channel',
  description: 'Run a poller or a reminder now instead of at its next time; what it reports reaches its subscribers.',
  input: { channel: z.string().trim().min(1).describe("The poller's or reminder's name or id.") },
  run: async ({ channel }) => {
    const info = await findChannel(channel)
    if (info.source === 'poller') {
      return pollerView(await pollNow(info.id), false)
    }
    if (info.source === 'reminder') {
      return reminderView(await runReminderNow(info.id), false)
    }
    throw new ToolRefusal(`${info.name} is a webhook: send it a sample with test_channel.`)
  },
})

const testChannelScript = setiTool({
  name: 'test_channel_script',
  description:
    'Run a poller or reminder script once without storing or delivering anything, and see what it returns, ' +
    'its log and any error: a draft script, a saved poller or reminder, or a new script for a saved one.',
  input: {
    script: z.string().min(1).optional().describe('The script to try; without a channel, give kind too.'),
    channel: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('A saved poller or reminder to test, or whose settings to use.'),
    kind: z.enum(['poller', 'reminder']).optional().describe('What a draft script is for, without a channel.'),
  },
  run: async ({ script, channel, kind }) => {
    const saved = channel === undefined ? null : await findChannel(channel)
    if (saved?.source === 'webhook') {
      throw new ToolRefusal(`${saved.name} is a webhook: send it a sample with test_channel.`)
    }
    const source = saved?.source ?? kind
    if (source === 'reminder') {
      return testReminderScript(script, saved?.source === 'reminder' ? saved : null)
    }
    if (source === 'poller') {
      return testPollerScript(script, saved?.source === 'poller' ? saved : null)
    }
    throw new ToolRefusal('Say whether the script is for a poller or a reminder, or name a saved one.')
  },
})

const deleteChannelTool = setiTool({
  name: 'delete_channel',
  description:
    'Delete a webhook, whose URL stops working, or a poller or reminder, which stops running; its events and ' +
    'deliveries go.',
  input: { channel: channelRef },
  run: async ({ channel }) => {
    const info = await findChannel(channel)
    await deleteChannel(info.id)
    return done(`Deleted the ${info.source} ${info.name}.`)
  },
})

const testChannel = setiTool({
  name: 'test_channel',
  description:
    'Send a webhook a signed sample event through the same checks as a real delivery; it reaches its subscribers like a real event.',
  input: { channel: webhookRef },
  run: async ({ channel }) => {
    const after = await webhooks.sendTest((await findWebhook(channel)).id)
    const latest = after.deliveries[0]
    return { webhook: after.name, delivery: latest === undefined ? null : deliveryView(latest) }
  },
})

const rotateChannelSecret = setiTool({
  name: 'rotate_channel_secret',
  description:
    'Have Seti issue a new signing secret for a webhook; the old one stops working at once, and the user copies the new one from Settings. You never see it.',
  input: { channel: webhookRef },
  run: async ({ channel }) => {
    const info = await findWebhook(channel)
    const { label, secret } = info.sender
    if (secret === 'sender') {
      throw new ToolRefusal(
        `${label} issues the secret of ${info.name}, so Seti cannot rotate it: the user makes a new one in ${label} and pastes it in Settings, Channels.`,
      )
    }
    return webhookView((await rotateChannel(info.id, undefined)).channel)
  },
})

export const CHANNEL_TOOLS: SetiTool[] = [
  listChannelsTool,
  getChannel,
  createChannelTool,
  updateChannelTool,
  subscribeChannelTool,
  unsubscribeChannelTool,
  deleteChannelTool,
  testChannel,
  rotateChannelSecret,
  runChannel,
  testChannelScript,
  ...POLLER_TOOLS,
  ...REMINDER_TOOLS,
]
