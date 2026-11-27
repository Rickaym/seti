import {
  CODEX_EFFORTS,
  CODEX_MODELS,
  GEMINI_MODELS,
  type ChannelInfo,
  type SettingsSectionPath,
  type SettingsSectionValue,
} from '@seti/shared'
import { listChannels } from '../channels/actions.js'
import { cpuCapSettings } from '../cpu-cap.js'
import { repos } from '../db.js'
import { memoryCapSettings } from '../memory-cap.js'
import { archiveSettings } from '../store/archive.js'
import { codexSettings } from '../store/codex-settings.js'
import { compactSettings } from '../store/compact.js'
import { dreamSettings } from '../store/dream-nights.js'
import { eaSettings } from '../store/ea.js'
import { geminiSettings } from '../store/gemini-settings.js'
import { notificationSettings } from '../store/notifications.js'
import { storageSettings } from '../store/storage.js'
import { currentSettings } from '../user-settings.js'

/** Reads each section of some paths from the stores the settings pages read. */
export type SectionReaders<P extends SettingsSectionPath> = { [K in P]: () => Promise<SettingsSectionValue<K>> }

type Channels = SettingsSectionValue<'agents.channels'>

function channelEntry(channel: ChannelInfo): Channels['channels'][string] {
  if (channel.source === 'webhook') {
    const filter = channel.filter === null ? null : { enabled: channel.filter.enabled, script: channel.filter.script }
    return { source: 'webhook', preset: channel.preset, filter }
  }
  if (channel.source === 'poller') {
    const { script, preset, interval_s, timeout_s, fingerprint_fields, detect_gone, enabled } = channel.poller
    return { source: 'poller', script, preset, interval_s, timeout_s, fingerprint_fields, detect_gone, enabled }
  }
  const { script, interval_s, schedule, enabled } = channel.reminder
  return { source: 'reminder', script, interval_s, schedule, enabled }
}

async function channels(): Promise<Channels> {
  const list = await listChannels()
  const pollers = list.flatMap((channel) => (channel.source === 'poller' ? [channel] : []))
  return {
    channels: Object.fromEntries(list.map((channel) => [channel.name, channelEntry(channel)])),
    poller_access: Object.fromEntries(
      pollers.map(({ name, poller }) => [name, { extra_hosts: poller.extra_hosts, secrets: poller.secrets }]),
    ),
    thread_replies: Object.fromEntries(
      list.flatMap((channel) =>
        channel.source === 'webhook' && channel.threads !== null
          ? [[channel.name, { replies: channel.threads.replies, dms: channel.threads.dms }]]
          : [],
      ),
    ),
  }
}

/** The App and Agents groups. */
export const APP_AGENT_READERS: SectionReaders<Extract<SettingsSectionPath, `app.${string}` | `agents.${string}`>> = {
  'app.general': async () => {
    const { name, theme } = await currentSettings()
    return { name: name === '' ? null : name, theme }
  },
  'app.notifications': async () => ({ tiers: await notificationSettings.get() }),
  'app.ea': async () => {
    const { wake_enabled, wake_phrase, keep_awake_seconds, join_on_open, form_of_address, language } =
      await eaSettings.get()
    return { wake_enabled, wake_phrase, keep_awake_seconds, join_on_open, form_of_address, language }
  },
  'agents.lifecycle': async () => {
    const { enabled, days, delete_after_days, resume_after_restart, repeat_guard } = await archiveSettings.get()
    return {
      auto_archive: { enabled, days, delete_after_days, resume_after_restart, repeat_guard },
      compaction: (await compactSettings.get()).rule,
      dreaming: await dreamSettings.get(),
    }
  },
  'agents.repos': async () => ({
    repos: Object.fromEntries((await repos.list()).map(({ slug, path, base_branch }) => [slug, { path, base_branch }])),
  }),
  'agents.resources': async () => ({
    memory_cap: (await memoryCapSettings()).cap,
    cpu_cap: (await cpuCapSettings()).cap,
  }),
  'agents.runtimes': async () => {
    const { enabled, program, evaluator_decides, default_model, default_effort } = await codexSettings.get()
    const model = CODEX_MODELS.find((known) => known === default_model) ?? null
    const effort = CODEX_EFFORTS.find((known) => known === default_effort) ?? null
    const gemini = await geminiSettings.get()
    return {
      codex: { enabled, program, evaluator_decides, default_model: model, default_effort: effort },
      gemini: {
        enabled: gemini.enabled,
        evaluator_decides: gemini.evaluator_decides,
        default_model: GEMINI_MODELS.find((known) => known === gemini.default_model) ?? null,
      },
    }
  },
  'agents.storage': async () => {
    const { enabled, idle_days } = await storageSettings.get()
    return { auto_clean: { enabled, idle_days } }
  },
  'agents.channels': channels,
}
