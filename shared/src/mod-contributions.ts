import { z } from 'zod'
import { localName, title } from './mod-names.js'
import { fenceRenderer, fileViewer } from './mod-viewers.js'

export { MOD_LOCAL_NAME } from './mod-names.js'
export { MOD_VIEWER_KINDS, VIEWER_BYTES_MAX, type ModFileViewer } from './mod-viewers.js'

const description = z.string().trim().max(300)
const lucideName = z
  .string()
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/, 'Name a lucide icon, such as kanban')

/** One setting: Seti renders its row and validates its value; the mod never draws the form. */
const settingField = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('string'),
    title,
    description: description.optional(),
    default: z.string().max(2000),
    maxLength: z.number().int().min(1).max(2000).default(200),
    options: z.array(z.string().max(60)).min(2).max(20).optional(),
  }),
  z.strictObject({ type: z.literal('boolean'), title, description: description.optional(), default: z.boolean() }),
  z.strictObject({
    type: z.literal('number'),
    title,
    description: description.optional(),
    default: z.number(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
])
export type ModSettingField = z.output<typeof settingField>

const argument = z.strictObject({
  type: z.enum(['string', 'number', 'boolean']),
  description: description.optional(),
  optional: z.boolean().default(false),
})

/** The argument that names the agent a command acts on; Seti resolves it and fills it in. */
export const MOD_TASK_ARG = 'task'

/** The longest text one argument of a mod command takes. */
const MOD_ARG_TEXT_MAX = 4000

/** A key a mod binds: Alt or Ctrl (Cmd on Apple), maybe Shift, then a letter, digit or arrow. */
export const MOD_CHORD = /^(Alt|Ctrl)\+(Shift\+)?([A-Z0-9]|Left|Right|Up|Down|\[|\])$/

const modChord = z.string().regex(MOD_CHORD, 'A chord is Alt or Ctrl, maybe Shift, and a letter, digit or arrow')

/** A guide row for keys a mod's view binds while it shows, such as Alt+Arrows on agents. */
const shortcut = z.strictObject({
  keys: z.string().trim().min(1).max(40),
  title,
  group: z.enum(['anywhere', 'agents']).default('anywhere'),
})

const command = z
  .strictObject({
    id: localName,
    title,
    icon: lucideName.optional(),
    description: description.optional(),
    args: z.record(localName, argument).default({}),
    /**
     * view: the mod's own views may run it through the bridge; agentHeader: an agent's header;
     * agentMenu: an agent's More actions.
     */
    for: z.array(z.enum(['palette', 'agentHeader', 'agentMenu', 'agents', 'ea', 'view'])).min(1),
    /** A key chord that runs it from anywhere, such as Alt+G; bundled mods only. */
    chord: modChord.optional(),
    /** Changes something, so the EA asks the user first, as for its own tools that change things. */
    changes: z.boolean().default(true),
    /** self: it acts only on the agent its task argument names, so a Self agent runs it on itself. */
    level: z.enum(['self', 'full']).default('full'),
    /** How long Seti waits for its handler before it answers that the action timed out. */
    timeoutSeconds: z.number().int().min(1).max(600).default(30),
  })
  .superRefine((entry, ctx) => {
    const task = entry.args[MOD_TASK_ARG]
    if (task !== undefined && task.type !== 'string') {
      ctx.addIssue({ code: 'custom', path: ['args', MOD_TASK_ARG], message: 'The task argument is a string' })
    }
    if (entry.level === 'self' && (task === undefined || task.optional)) {
      ctx.addIssue({ code: 'custom', path: ['level'], message: 'A self command takes a required task argument' })
    }
    if (entry.for.includes('agentHeader') && task === undefined) {
      ctx.addIssue({ code: 'custom', path: ['for'], message: "A command in an agent's header takes a task argument" })
    }
    if (entry.for.includes('agentMenu') && task === undefined) {
      ctx.addIssue({ code: 'custom', path: ['for'], message: "A command in an agent's menu takes a task argument" })
    }
    const asked = Object.entries(entry.args).find(([name, arg]) => name !== MOD_TASK_ARG && !arg.optional)
    if (entry.chord !== undefined && asked !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['chord'], message: 'A chord runs a command with no required argument' })
    }
    if ((entry.for.includes('palette') || entry.for.includes('agentMenu')) && asked !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['args', asked[0]],
        message: 'A palette or menu command takes no required argument besides task',
      })
    }
  })
export type ModCommand = z.output<typeof command>
type ModCommandArgument = z.output<typeof argument>

const slashCommand = z.strictObject({
  name: z
    .string()
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/, 'A slash command name is lowercase letters, digits and -'),
  description,
  argumentHint: z.string().max(60).default(''),
  /** The mod command it runs, by its local id. */
  command: localName.optional(),
})

const headerName = z
  .string()
  .max(60)
  .regex(/^[A-Za-z][A-Za-z0-9-]*$/, 'A header name is letters, digits and -, such as X-Hub-Signature-256')

/**
 * A sender a webhook can take. Seti checks its HMAC-SHA256 signature before any of the mod's code
 * reads the body, so a mod can neither skip the check nor see the channel's secret.
 */
const webhookSource = z.strictObject({
  id: localName,
  kind: z.literal('webhook'),
  title,
  description,
  /** The header holding the hex HMAC-SHA256 of the body, after `prefix`, such as sha256=. */
  signature: z.strictObject({
    header: headerName,
    prefix: z
      .string()
      .max(20)
      .regex(/^[\w=:-]*$/)
      .default(''),
  }),
  /** The header with the sender's own id for each delivery; Seti hashes the body without one. */
  delivery: headerName.optional(),
  /** generated: Seti makes the secret; sender: the sender issues it and the user pastes it in. */
  secret: z.enum(['generated', 'sender']),
  /** Also take a form body whose payload field holds the JSON, as GitHub can send. */
  formPayload: z.boolean().default(false),
  kinds: z.array(z.string().max(80)).max(40).default([]),
  /** How to point the sender at the webhook. */
  setup: description,
})

/** A script a new poller can start from; the mod's server half gives the script. */
const pollerSource = z.strictObject({ id: localName, kind: z.literal('poller'), title, description })

const channelSource = z.discriminatedUnion('kind', [webhookSource, pollerSource])
export type ModChannelSource = z.output<typeof channelSource>
export type ModWebhookSource = z.output<typeof webhookSource>

const view = z.strictObject({
  id: localName,
  title,
  icon: lucideName.optional(),
  /** A short line beside the title, where the place shows one, such as a dock's header. */
  description: z.string().trim().max(80).optional(),
  /**
   * header is the band across the app header; about is a part of Settings, About; agentsLayout
   * shows several agents at once in the Agents section; agentDock is a panel over one agent's
   * chat, a bottom sheet on a phone.
   */
  where: z.enum(['agentTab', 'agentDock', 'sidePanel', 'section', 'agentsLayout', 'header', 'about']),
  phone: z.boolean(),
  entry: z.string().max(200).optional(),
})

const statusItem = z.strictObject({
  id: localName,
  title,
  icon: lucideName.optional(),
  command: localName.optional(),
})

const notificationKind = z.strictObject({
  id: localName,
  title,
  description: description.optional(),
  default: z.boolean().default(true),
})

/** text: the mod's fixed context, where only {{settings.<key>}} is filled in. */
const contextProvider = z.strictObject({
  id: localName,
  title,
  description: description.optional(),
  text: z.string().min(1).max(2000),
})

const MINUTE_MS = 60_000
const EVERY_UNITS: Readonly<Record<string, number>> = { m: MINUTE_MS, h: 60 * MINUTE_MS, d: 24 * 60 * MINUTE_MS }
const EVERY = /^([1-9]\d{0,3})([mhd])$/

/** How often a schedule runs, in ms, from a duration such as 15m, 2h or 1d; null when malformed. */
export function everyMs(every: string): number | null {
  const match = EVERY.exec(every)
  const unit = EVERY_UNITS[match?.[2] ?? '']
  return match === null || unit === undefined ? null : Number(match[1]) * unit
}

export const SCHEDULE_MIN_MS = 5 * MINUTE_MS
export const SCHEDULE_MAX_MS = 24 * 60 * MINUTE_MS

/** A schedule that fires the mod's onSchedule handler, with up to 10% jitter. */
const schedule = z.strictObject({
  id: localName,
  every: z.string().refine((every) => {
    const ms = everyMs(every)
    return ms !== null && ms >= SCHEDULE_MIN_MS && ms <= SCHEDULE_MAX_MS
  }, 'Run every 5m to 1d, such as 15m, 2h or 1d'),
})

/** Task events a mod's onTaskEvent handler may hear; it needs tasks.read. */
export const MOD_TASK_EVENTS = ['turn_finished', 'needs_you', 'status_changed', 'pr_linked', 'pr_merged'] as const
export type ModTaskEvent = (typeof MOD_TASK_EVENTS)[number]

/** A route under /api/mods/<id>/; only routes marked demo answer in the public demo. */
const route = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z
    .string()
    .max(120)
    .regex(/^(?:\/(?:[a-z0-9-]+|:[a-z][a-z0-9_]*))+$/, 'A route path is /segments of lowercase words or :params')
    .refine((path) => !/^\/actions(?:\/|$)/.test(path), 'Seti runs commands under /actions'),
  demo: z.boolean().default(false),
  /** It answers with server-sent events, written as the handler goes. */
  stream: z.boolean().default(false),
})

const publicPath = z.strictObject({
  path: z
    .string()
    .max(120)
    .regex(/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/, 'A public path is exact, with no parameters'),
})

/** An entry that names what a mod adds and nothing more, such as an input hook. */
const named = z.strictObject({ id: localName, title })

const unique =
  <T>(key: (entry: T) => string, what: string) =>
  (entries: readonly T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>()
    for (const entry of entries) {
      const name = key(entry)
      if (seen.has(name)) {
        ctx.addIssue({ code: 'custom', message: `${what} ${name} is declared twice` })
      }
      seen.add(name)
    }
  }

/** A CSS colour a manifest may give: hex only, so a value can never carry other CSS. */
const hexColour = z.string().regex(/^#[\da-f]{6}$/i, 'A colour is hex, such as #1e1e2e')
const swatch = z.strictObject({ background: hexColour, primary: hexColour, foreground: hexColour })

const themeOption = z.strictObject({
  id: localName,
  title,
  /** A hex colour, or a custom property the theme's tokens define, such as --ctp-mauve. */
  swatch: z.union([hexColour, z.string().regex(/^--[a-z][a-z0-9-]*$/, 'A swatch names a custom property')]),
})

/** A choice the theme offers beyond light and dark, set on <html> while the theme is on. */
const themeChoice = z
  .strictObject({ options: z.array(themeOption).min(1).max(20), fallback: localName })
  .refine((choice) => choice.options.some((option) => option.id === choice.fallback), 'The fallback is an option')
  .superRefine((choice, ctx) => {
    unique((option: { id: string }) => option.id, 'Option')(choice.options, ctx)
  })

export const THEME_SCHEMES = ['light', 'dark'] as const

/** Token values in a CSS file of the mod, scoped to `:root[data-theme='<mod>.<id>']`. */
const theme = z
  .strictObject({
    id: localName,
    title,
    description: description.optional(),
    tokens: z
      .string()
      .max(80)
      .regex(/^[a-z0-9-]+\.css$/, 'Tokens are a .css file beside the manifest'),
    /** One scheme pins the theme to it, and the light and dark control no longer applies. */
    schemes: z.array(z.enum(THEME_SCHEMES)).min(1).max(2).default(['light', 'dark']),
    /** Background, accent and text in each scheme, for the theme picker. */
    swatch: z.strictObject({ light: swatch.optional(), dark: swatch.optional() }),
    /** Dark palettes, set as `data-flavour`. */
    flavours: themeChoice.optional(),
    /** Accent colours, set as `data-accent`. */
    accents: themeChoice.optional(),
  })
  .refine((entry) => entry.schemes.every((scheme) => entry.swatch[scheme] !== undefined), 'Give a swatch per scheme')
export type ModTheme = z.output<typeof theme>

/** A stylesheet beside the manifest that the UI adds while the mod runs; bundled mods only. */
const style = z.strictObject({
  id: localName,
  file: z
    .string()
    .max(80)
    .regex(/^[a-z0-9-]+\.css$/, 'A style is a .css file beside the manifest'),
})

const byId = <S extends z.ZodType<{ id: string }>>(schema: S, what: string) =>
  z
    .array(schema)
    .max(50)
    .default([])
    .superRefine(unique((entry: { id: string }) => entry.id, what))

/** Why a slash command cannot run the command it names, or null when it can. */
function slashTargetProblem(target: ModCommand | undefined): string | null {
  if (target === undefined) {
    return 'A slash command runs a command the manifest declares'
  }
  const rest = Object.entries(target.args).filter(([name]) => name !== MOD_TASK_ARG)
  const [first] = rest
  return rest.length > 1 || (first !== undefined && first[1].type !== 'string')
    ? 'A slash command runs a command with at most one string argument besides task'
    : null
}

/** Everything a mod adds, as data Seti reads before any of the mod's code runs. */
export const modContributions = z
  .strictObject({
    settings: z.record(localName, settingField).default({}),
    commands: byId(command, 'Command'),
    slashCommands: z
      .array(slashCommand)
      .max(20)
      .default([])
      .superRefine(unique((entry: { name: string }) => entry.name, 'Slash command')),
    channelSources: byId(channelSource, 'Channel source'),
    fileViewers: byId(fileViewer, 'File viewer'),
    fenceRenderers: z
      .array(fenceRenderer)
      .max(20)
      .default([])
      .superRefine(unique((entry: { language: string }) => entry.language, 'Fence renderer')),
    views: byId(view, 'View'),
    statusBar: byId(statusItem, 'Status bar item'),
    notifications: byId(notificationKind, 'Notification kind'),
    contextProviders: byId(contextProvider, 'Context provider'),
    themes: byId(theme, 'Theme'),
    styles: byId(style, 'Style'),
    routes: z
      .array(route)
      .max(50)
      .default([])
      .superRefine(unique((entry: { method: string; path: string }) => `${entry.method} ${entry.path}`, 'Route')),
    publicPaths: z.array(publicPath).max(10).default([]),
    inputHooks: byId(named, 'Input hook'),
    hostProxies: byId(named, 'Host proxy'),
    prDecorators: byId(named, 'PR decorator'),
    prChips: byId(named, 'PR chip'),
    shortcuts: z.array(shortcut).max(10).default([]),
    statusMarkers: byId(named, 'Status marker'),
    agentAccents: byId(named, 'Agent accent'),
    transcriptBlocks: byId(named, 'Transcript block'),
    auditKinds: z.array(localName).max(50).default([]).superRefine(unique(String, 'Audit kind')),
    schedules: byId(schedule, 'Schedule'),
    taskEvents: z.array(z.enum(MOD_TASK_EVENTS)).max(5).default([]).superRefine(unique(String, 'Task event')),
  })
  .superRefine((contributes, ctx) => {
    for (const [point, entries] of [
      ['fileViewers', contributes.fileViewers],
      ['fenceRenderers', contributes.fenceRenderers],
    ] as const) {
      for (const [i, entry] of entries.entries()) {
        if (entry.setting !== undefined && contributes.settings[entry.setting]?.type !== 'boolean') {
          ctx.addIssue({ code: 'custom', path: [point, i, 'setting'], message: 'Name a boolean setting it declares' })
        }
      }
    }
    for (const [i, slash] of contributes.slashCommands.entries()) {
      const target = contributes.commands.find((entry) => entry.id === slash.command)
      const problem = slash.command === undefined ? null : slashTargetProblem(target)
      if (problem !== null) {
        ctx.addIssue({ code: 'custom', path: ['slashCommands', i, 'command'], message: problem })
      }
    }
  })
export type ModContributions = z.output<typeof modContributions>
export type ModPoint = keyof ModContributions

/** How each contribution point behaves in this release of the mod API. */
interface PointRule {
  /** Seti has a registry for it; a mod that uses a point without one cannot be turned on yet. */
  available: boolean
  /** Its entries take full effect only after Seti restarts. */
  restart: boolean
  /** Third-party mods never get it: a new door into Seti, or every keystroke. */
  bundledOnly: boolean
  /** Third-party mods may add it; a closed point stays with the mods Seti ships. */
  thirdParty: boolean
}

export const MOD_POINTS: Readonly<Record<ModPoint, PointRule>> = {
  settings: { available: true, restart: false, bundledOnly: false, thirdParty: true },
  commands: { available: true, restart: false, bundledOnly: false, thirdParty: true },
  slashCommands: { available: true, restart: false, bundledOnly: false, thirdParty: true },
  channelSources: { available: true, restart: false, bundledOnly: false, thirdParty: true },
  fileViewers: { available: true, restart: false, bundledOnly: false, thirdParty: true },
  fenceRenderers: { available: true, restart: false, bundledOnly: true, thirdParty: false },
  views: { available: true, restart: false, bundledOnly: false, thirdParty: true },
  statusBar: { available: true, restart: false, bundledOnly: false, thirdParty: true },
  notifications: { available: true, restart: false, bundledOnly: false, thirdParty: true },
  contextProviders: { available: true, restart: false, bundledOnly: false, thirdParty: true },
  themes: { available: true, restart: false, bundledOnly: false, thirdParty: true },
  styles: { available: true, restart: false, bundledOnly: true, thirdParty: false },
  routes: { available: true, restart: false, bundledOnly: true, thirdParty: false },
  publicPaths: { available: false, restart: true, bundledOnly: true, thirdParty: false },
  inputHooks: { available: true, restart: false, bundledOnly: true, thirdParty: false },
  hostProxies: { available: true, restart: false, bundledOnly: true, thirdParty: false },
  prDecorators: { available: true, restart: false, bundledOnly: true, thirdParty: false },
  prChips: { available: true, restart: false, bundledOnly: false, thirdParty: false },
  shortcuts: { available: true, restart: false, bundledOnly: true, thirdParty: false },
  statusMarkers: { available: true, restart: false, bundledOnly: true, thirdParty: false },
  agentAccents: { available: true, restart: false, bundledOnly: true, thirdParty: false },
  transcriptBlocks: { available: true, restart: false, bundledOnly: true, thirdParty: false },
  auditKinds: { available: true, restart: false, bundledOnly: false, thirdParty: true },
  schedules: { available: true, restart: false, bundledOnly: false, thirdParty: true },
  taskEvents: { available: true, restart: false, bundledOnly: false, thirdParty: true },
}

/** Views have a registry only where Seti can place them now. */
export const AVAILABLE_VIEW_PLACES: ReadonlySet<string> = new Set([
  'section',
  'header',
  'about',
  'agentsLayout',
  'agentDock',
])

/** Where a third-party mod's sandboxed view can sit: never in Seti's header or Settings, About. */
export const THIRD_PARTY_VIEW_PLACES: ReadonlySet<string> = new Set(['section', 'agentTab', 'sidePanel'])

/** The points a mod's manifest fills in. */
export function usedPoints(contributes: ModContributions): ModPoint[] {
  return (Object.keys(MOD_POINTS) as ModPoint[]).filter((point) => {
    const value = contributes[point]
    return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0
  })
}

/** The value schema of a mod's settings, built from its manifest; unknown keys are refused. */
export function modSettingsSchema(fields: Readonly<Record<string, ModSettingField>>) {
  const shape: Record<string, z.ZodType> = {}
  for (const [key, field] of Object.entries(fields)) {
    shape[key] = settingValueSchema(field).optional()
  }
  return z.strictObject(shape)
}

function settingValueSchema(field: ModSettingField): z.ZodType {
  switch (field.type) {
    case 'string': {
      const text = z.string().max(field.maxLength)
      return field.options === undefined ? text : text.refine((value) => field.options?.includes(value) === true)
    }
    case 'boolean':
      return z.boolean()
    case 'number':
      return z
        .number()
        .refine((value) => field.min === undefined || value >= field.min, `At least ${String(field.min)}`)
        .refine((value) => field.max === undefined || value <= field.max, `At most ${String(field.max)}`)
  }
}

function argumentSchema(arg: ModCommandArgument): z.ZodType {
  const base = { string: z.string().max(MOD_ARG_TEXT_MAX), number: z.number(), boolean: z.boolean() }[arg.type]
  const described = arg.description === undefined ? base : base.describe(arg.description)
  return arg.optional ? described.optional() : described
}

/** The arguments of a mod command as a zod shape, each described as the manifest says. */
export function modCommandArgShape(entry: ModCommand): Record<string, z.ZodType> {
  return Object.fromEntries(Object.entries(entry.args).map(([name, arg]) => [name, argumentSchema(arg)]))
}

/** The arguments a mod command takes; unknown ones are refused. */
export const modCommandArgs = (entry: ModCommand) => z.strictObject(modCommandArgShape(entry))

/** The argument a slash command's text fills: the one besides task, or null when there is none. */
export const slashTextArg = (entry: ModCommand): string | null =>
  Object.keys(entry.args).find((name) => name !== MOD_TASK_ARG) ?? null
