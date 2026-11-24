import { z } from 'zod'
import { autoArchiveInput } from './archive.js'
import { attentionTiersInput } from './attention.js'
import { compactRuleInput } from './compact.js'
import { cpuCapInput } from './cpu.js'
import { dreamSettingsInput } from './dreams.js'
import { eaSettingsInput } from './ea.js'
import { memoryCapInput } from './memory.js'
import { pollerSettingsInput } from './pollers.js'
import { reminderSettingsInput } from './reminders.js'
import { repoInput } from './repos.js'
import { codexSettingsInput } from './runtimes/settings.js'
import { documented, held, keyedBy, settingsSection } from './settings-doc.js'
import { storageScheduleInput } from './storage.js'
import { themeChoice, userSettingsInput } from './user.js'

const tiers = attentionTiersInput.shape
const ea = eaSettingsInput.shape
const archive = autoArchiveInput.shape
const compact = compactRuleInput.shape
const dream = dreamSettingsInput.shape
const memory = memoryCapInput.shape
const codex = codexSettingsInput.shape
const storage = storageScheduleInput.shape
const poller = pollerSettingsInput.shape
const reminder = reminderSettingsInput.shape

const general = settingsSection({
  page: 'general',
  description: 'Your name and the theme every device uses',
  schema: documented(
    {
      name: held(userSettingsInput.shape.name).nullable(),
      theme: documented(
        { id: themeChoice.shape.id, flavour: themeChoice.shape.flavour, accent: themeChoice.shape.accent },
        {
          id: "default for Seti's own theme, or a mod's as <mod>.<theme>",
          flavour: 'The flavour of a theme that offers several; null for its first',
          accent: 'The accent colour of a theme that offers several; null for its own',
        },
      ).nullable(),
    },
    {
      name: 'What Seti calls you, as on the start page; null until Seti knows it',
      theme: "The theme every device uses: Seti's own (null) or a mod's as <mod>.<theme>",
    },
  ),
  security: [],
})

const notifications = settingsSection({
  page: 'notifications',
  description: 'How each tier of news reaches you',
  schema: documented(
    {
      tiers: documented(
        {
          urgent: held(tiers.urgent),
          active: held(tiers.active),
          digest: held(tiers.digest),
          passive: held(tiers.passive),
        },
        {
          urgent: 'Agents that need you: a push or a toast',
          active: 'Agents you watch finishing or asking: push, toast, brief or off',
          digest: "A watched agent's routine news: push, toast, brief or off",
          passive: 'Everything else: push, toast, brief or off',
        },
      ),
    },
    { tiers: 'Where each tier of news goes' },
  ),
  security: [],
})

const assistant = settingsSection({
  page: 'ea',
  description: 'The EA, your voice assistant',
  schema: documented(
    {
      wake_enabled: ea.wake_enabled,
      wake_phrase: ea.wake_phrase,
      keep_awake_seconds: ea.keep_awake_seconds,
      join_on_open: ea.join_on_open,
      form_of_address: held(ea.form_of_address),
      language: held(ea.language),
    },
    {
      wake_enabled: 'The EA listens for its wake word',
      wake_phrase: 'Two to four words that wake the EA, such as Hey Seti',
      keep_awake_seconds: 'How long the EA stays awake after your last words, in seconds',
      join_on_open: 'With the wake word on, an open Seti joins the call asleep',
      form_of_address: 'What the EA calls you now and then; empty for nothing',
      language: 'The language the EA listens, speaks and writes in, or multi',
    },
  ),
  security: [],
})

const lifecycle = settingsSection({
  page: 'agents',
  description: 'How agents are archived, compacted and dream',
  schema: documented(
    {
      auto_archive: documented(
        {
          enabled: held(archive.enabled),
          days: held(archive.days),
          delete_after_days: held(archive.delete_after_days),
          resume_after_restart: held(archive.resume_after_restart),
          repeat_guard: held(archive.repeat_guard),
        },
        {
          enabled: 'Archive finished agents that sit idle',
          days: 'Days idle before a finished agent is archived',
          delete_after_days: 'Days after archiving that an agent is deleted with its files; null keeps them',
          resume_after_restart: 'Agents a restart cut off get one message to go on at startup',
          repeat_guard: 'An agent that repeats a call with the same result waits for you',
        },
      ),
      compaction: documented(
        {
          auto: compact.auto,
          window_k: compact.window_k,
          threshold_pct: compact.threshold_pct,
          instructions: compact.instructions,
        },
        {
          auto: 'Claude Code compacts a conversation by itself when it fills',
          window_k: "The context window to compact at, in thousands of tokens; null is Claude Code's own",
          threshold_pct: "Compact at this share of the window; null is Claude Code's own",
          instructions: 'What a compaction keeps, in your words; null for none',
        },
      ),
      dreaming: documented(
        {
          enabled: held(dream.enabled),
          window_start: held(dream.window_start),
          window_end: held(dream.window_end),
          zone: held(dream.zone).nullable(),
          model: held(dream.model),
          dream_budget_usd: held(dream.dream_budget_usd),
          night_budget_usd: held(dream.night_budget_usd),
          at_once: held(dream.at_once),
          cleanups: held(dream.cleanups),
        },
        {
          enabled: 'Agents dream at night: they tidy their memory while you sleep',
          window_start: 'When the night window opens, as local HH:MM',
          window_end: 'When it closes; at or before the start means the next day',
          zone: 'The time zone of the window; null until you first save one',
          model: 'The model dreams run on',
          dream_budget_usd: 'Most one dream may spend, in US dollars',
          night_budget_usd: 'Most all dreams of a night may spend, in US dollars',
          at_once: 'How many dreams run at once, 1 to 3',
          cleanups: 'Dreams may propose clean-ups for you to allow; off reports only',
        },
      ),
    },
    {
      auto_archive: 'Archiving and deleting idle agents',
      compaction: 'The compaction rule every agent gets unless it has its own',
      dreaming: 'Dreaming: memory upkeep at night',
    },
  ),
  security: [],
})

const resources = settingsSection({
  page: 'resources',
  description: 'The memory and CPU every agent gets unless it has its own',
  schema: documented(
    {
      memory_cap: documented(
        { high_mb: memory.high_mb, max_mb: memory.max_mb, swap_max_mb: memory.swap_max_mb },
        {
          high_mb: 'Soft cap in MiB: above it the agent is slowed and reclaimed',
          max_mb: 'RAM cap in MiB: at it the largest tool process is stopped',
          swap_max_mb: 'Swap an agent may use, in MiB',
        },
      ),
      cpu_cap: documented(
        { quota_percent: cpuCapInput.shape.quota_percent },
        { quota_percent: 'CPU share in percent of one core, 100 per core; null for no cap' },
      ),
    },
    { memory_cap: 'The default memory cap', cpu_cap: 'The default CPU cap' },
  ),
  security: [],
})

const runtimes = settingsSection({
  page: 'runtimes',
  description: 'The programs agents run on',
  schema: documented(
    {
      codex: documented(
        {
          enabled: held(codex.enabled),
          program: held(codex.program),
          evaluator_decides: held(codex.evaluator_decides),
          default_model: held(codex.default_model),
          default_effort: held(codex.default_effort),
        },
        {
          enabled: 'Codex is offered as a runtime for new agents',
          program: 'The codex program agents start; null for the one Seti installs',
          evaluator_decides: 'Rules decide: an allow rule or the read-only list answers a call without you',
          default_model: "The model a new Codex agent starts with; null is Codex's own",
          default_effort: "Its reasoning effort; null is Codex's own",
        },
      ),
    },
    { codex: 'OpenAI Codex' },
  ),
  security: ['codex'],
})

const storageSection = settingsSection({
  page: 'storage',
  description: "Cleaning agents' rebuildable folders",
  schema: documented(
    {
      auto_clean: documented(
        { enabled: held(storage.enabled), idle_days: held(storage.idle_days) },
        {
          enabled: 'Seti cleans rebuildable folders of idle agents by itself',
          idle_days: 'Days idle before an agent is cleaned: 7, 14 or 30',
        },
      ),
    },
    { auto_clean: 'The automatic clean, which only you turn on' },
  ),
  security: 'all',
})

const repos = settingsSection({
  page: 'repos',
  description: 'Repositories Seti knows, by owner/name',
  schema: documented(
    {
      repos: keyedBy(
        documented(
          { path: repoInput.shape.path, base_branch: repoInput.shape.base_branch },
          { path: 'The checkout on this machine', base_branch: 'The branch agents start from' },
        ),
      ),
    },
    { repos: 'Each repository by its owner/name' },
  ),
  security: [],
})

const webhook = documented(
  {
    source: z.literal('webhook'),
    preset: z.string(),
    filter: documented(
      { enabled: z.boolean(), script: z.string() },
      { enabled: 'The filter runs', script: 'The code that drops or reshapes deliveries' },
    ).nullable(),
  },
  {
    source: 'A webhook other services post to',
    preset: 'The sender it takes, such as github',
    filter: 'Its filter; null without one',
  },
)

const pollerItem = documented(
  {
    source: z.literal('poller'),
    script: poller.script,
    preset: poller.preset,
    interval_s: poller.interval_s,
    timeout_s: poller.timeout_s,
    fingerprint_fields: poller.fingerprint_fields,
    detect_gone: poller.detect_gone,
    enabled: poller.enabled,
  },
  {
    source: 'A poller: code Seti runs on a schedule to find new items',
    script: 'The code that fetches items',
    preset: 'The template it started from',
    interval_s: 'Seconds between runs',
    timeout_s: 'Seconds a run may take',
    fingerprint_fields: 'Fields that make an item new when they change',
    detect_gone: 'Report items that disappear',
    enabled: 'The poller runs',
  },
)

const reminderItem = documented(
  {
    source: z.literal('reminder'),
    script: reminder.script,
    interval_s: reminder.interval_s,
    schedule: reminder.schedule,
    enabled: reminder.enabled,
  },
  {
    source: 'A reminder: code Seti runs on a schedule to say something',
    script: 'The code that writes the reminder',
    interval_s: 'Seconds between runs when no schedule is set',
    schedule: 'A cron schedule and its time zone; null runs by the interval',
    enabled: 'The reminder runs',
  },
)

const channels = settingsSection({
  page: 'channels',
  description: 'Webhooks, pollers and reminders that bring news to agents and the EA',
  schema: documented(
    {
      channels: keyedBy(z.discriminatedUnion('source', [webhook, pollerItem, reminderItem])),
      poller_access: keyedBy(
        documented(
          { extra_hosts: poller.extra_hosts, secrets: poller.secrets },
          { extra_hosts: 'Hosts the poller may reach besides its own', secrets: 'Connections whose value it may send' },
        ),
      ),
    },
    {
      channels: 'Each channel by its name',
      poller_access: 'What each poller may reach and which connections it may use; only you change these',
    },
  ),
  security: ['poller_access'],
})

/** The App and Agents groups. */
export const APP_AGENT_SECTIONS = {
  'app.general': general,
  'app.notifications': notifications,
  'app.ea': assistant,
  'agents.lifecycle': lifecycle,
  'agents.repos': repos,
  'agents.resources': resources,
  'agents.runtimes': runtimes,
  'agents.storage': storageSection,
  'agents.channels': channels,
} as const
