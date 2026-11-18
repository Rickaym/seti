import { z } from 'zod'
import {
  connectionInput,
  connectionValue,
  envFor,
  firstFree,
  hostMatches,
  KIND_SLOTS,
  type ClientAuth,
  type ConnectionHeader,
  type ConnectionInput,
  type ConnectionKind,
  type ConnectionRequest,
  type ConnectionSlot,
} from './connections.js'
import type { ServiceIconKey } from './service-icons.js'

export const TEMPLATE_CATEGORIES = [
  'cloud',
  'ai',
  'voice',
  'payments',
  'messaging',
  'email',
  'developer',
  'monitoring',
  'work',
] as const
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]

export type TemplateFieldFormat = 'text' | 'guid' | 'email' | 'subdomain'

/** One thing a template asks for, named as the service names it. */
export interface ConnectionTemplateField {
  key: string
  label: string
  help: string
  placeholder: string
  /** The slot a secret is stored in; null for a setting that fills `{key}` in the connection. */
  slot: ConnectionSlot | null
  format: TemplateFieldFormat
  required: boolean
}

/** One API of a service the user can tick: its hosts and the scope a token for it needs. */
export interface ConnectionTemplatePart {
  id: string
  title: string
  description: string
  hosts: string[]
  /** The least it can ask for: read only where the service has such a scope. */
  scope: string
  /** The scope that also writes, which the user switches on; null when there is one scope. */
  write_scope: string | null
}

/** A template's token settings; text may hold `{key}` for a field that is not secret. */
export interface ConnectionTemplateMint {
  token_url: string
  client_id: string | null
  client_auth: ClientAuth
  subject: string | null
}

/** A named service ready to add: what to ask for and the connections that makes. */
export interface ConnectionTemplate {
  id: string
  title: string
  description: string
  category: TemplateCategory
  /** The brand mark beside its name; its category's icon stands in when null. */
  icon: ServiceIconKey | null
  /** The service's own page on signing in to its API. */
  docs: string
  fields: ConnectionTemplateField[]
  name: string
  /** The variable agents see; derived from the name when null. */
  env: string | null
  kind: ConnectionKind
  hosts: string[]
  /** The header Seti adds; null when the agent sends the value itself. */
  header: ConnectionHeader | null
  mint: ConnectionTemplateMint | null
  parts: ConnectionTemplatePart[]
  /** Whether each ticked part is its own connection, or all share one token. */
  parts_mode: 'each' | 'merge'
  /** What the user or the agent still does, in a sentence; empty when nothing. */
  note: string
}

const KEY = z.string().min(1).max(64)

/** A template filled in: its parts, its settings by field key and its secrets by field key. */
export const connectionTemplateInput = z.object({
  template: KEY,
  parts: z.array(KEY).max(20).default([]),
  /** The parts that may also write. */
  write: z.array(KEY).max(20).default([]),
  fields: z.record(KEY, z.string().trim().max(500)).default({}),
  values: z.record(KEY, connectionValue).default({}),
  profile_ids: z.array(z.string().min(1).max(64)).max(100).default([]),
})
export type ConnectionTemplateInput = z.input<typeof connectionTemplateInput>
export type ConnectionTemplateRequest = z.output<typeof connectionTemplateInput>

const FORMATS: Record<TemplateFieldFormat, { pattern: RegExp; hint: string }> = {
  text: { pattern: /^[^\s{}]+$/, hint: 'has no spaces' },
  guid: {
    pattern: /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
    hint: 'is a GUID such as 0000aaaa-11bb-22cc-33dd-444444eeeeee',
  },
  email: { pattern: /^[^\s@{}]+@[^\s@{}.]+(\.[^\s@{}.]+)+$/, hint: 'is an email address' },
  subdomain: { pattern: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, hint: 'is the first part of the host, such as your-domain' },
}

type Outcome<T> = T | { error: string }

/** The template's settings as typed, checked; an empty optional one stays empty. */
function settingsOf(
  template: ConnectionTemplate,
  given: Readonly<Record<string, string>>,
): Outcome<Map<string, string>> {
  const settings = new Map<string, string>()
  for (const field of template.fields.filter((entry) => entry.slot === null)) {
    const raw = (given[field.key] ?? '').trim()
    const value = field.format === 'text' ? raw : raw.toLowerCase()
    if (value === '') {
      if (field.required) {
        return { error: `Enter the ${field.label}` }
      }
    } else if (!FORMATS[field.format].pattern.test(value)) {
      return { error: `The ${field.label} ${FORMATS[field.format].hint}` }
    }
    settings.set(field.key, value)
  }
  return settings
}

const fill = (text: string, settings: ReadonlyMap<string, string>) =>
  text.replace(/\{([a-z_]+)\}/g, (whole, key: string) => settings.get(key) ?? whole)

const filled = (text: string | null, settings: ReadonlyMap<string, string>) => {
  const value = text === null ? '' : fill(text, settings)
  return value === '' ? null : value
}

const unique = (items: readonly string[]) => [...new Set(items)]

/** Hosts without the ones a wildcard among them already covers. */
const withoutCovered = (hosts: readonly string[]) =>
  unique(hosts).filter((host) => !hosts.some((other) => other !== host && hostMatches(other, host)))

interface Draft {
  name: string
  hosts: string[]
  scope: string | null
}

const scopeOf = (part: ConnectionTemplatePart, choice: TemplateChoice) =>
  part.write_scope !== null && (choice.write ?? []).includes(part.id) ? part.write_scope : part.scope

function draftsOf(template: ConnectionTemplate, choice: TemplateChoice): Outcome<{ drafts: Draft[] }> {
  const chosen = choice.parts
  if (template.parts.length === 0) {
    return { drafts: [{ name: template.name, hosts: template.hosts, scope: null }] }
  }
  const unknown = chosen.find((id) => !template.parts.some((part) => part.id === id))
  if (unknown !== undefined) {
    return { error: `${template.title} has no ${unknown}` }
  }
  const parts = template.parts.filter((part) => chosen.includes(part.id))
  if (parts.length === 0) {
    return { error: 'Pick at least one API' }
  }
  if (template.parts_mode === 'each') {
    const drafts = parts.map((part) => ({
      name: `${template.name}_${part.id}`,
      hosts: part.hosts,
      scope: scopeOf(part, choice),
    }))
    return { drafts }
  }
  const merged = [
    {
      name: template.name,
      hosts: withoutCovered([...template.hosts, ...parts.flatMap((part) => part.hosts)]),
      scope: unique(parts.flatMap((part) => scopeOf(part, choice).split(' '))).join(' '),
    },
  ]
  return { drafts: merged }
}

/** Names and variables already in use, which a template's connections step around. */
export interface TemplateTaken {
  names: ReadonlySet<string>
  envs: ReadonlySet<string>
}

export interface TemplateChoice {
  parts: readonly string[]
  write?: readonly string[]
  fields: Readonly<Record<string, string>>
}

/**
 * The connections a filled-in template makes, with free names and variables, or the first thing
 * still missing. Secrets are not part of it: they go to their slots as the connections are made.
 */
export function expandTemplate(
  template: ConnectionTemplate,
  choice: TemplateChoice,
  taken: TemplateTaken,
): Outcome<{ connections: ConnectionRequest[] }> {
  const settings = settingsOf(template, choice.fields)
  if ('error' in settings) {
    return settings
  }
  const drafted = draftsOf(template, choice)
  if ('error' in drafted) {
    return drafted
  }
  const { drafts } = drafted
  const names = new Set(taken.names)
  const envs = new Set(taken.envs)
  const connections: ConnectionRequest[] = []
  for (const draft of drafts) {
    const name = firstFree(draft.name, (candidate) => !names.has(candidate))
    const wanted = drafts.length === 1 && template.env !== null ? template.env : envFor(draft.name)
    const env = firstFree(wanted, (candidate) => !envs.has(candidate))
    names.add(name)
    envs.add(env)
    const { mint } = template
    const input: ConnectionInput = {
      name,
      kind: template.kind,
      env,
      hosts: draft.hosts.map((host) => fill(host, settings)),
      header: template.header,
      mint:
        mint === null
          ? null
          : {
              token_url: fill(mint.token_url, settings),
              client_id: filled(mint.client_id, settings),
              client_auth: mint.client_auth,
              subject: filled(mint.subject, settings),
              scope: draft.scope,
            },
    }
    const parsed = connectionInput.safeParse(input)
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? 'Check the connection' }
    }
    connections.push(parsed.data)
  }
  return { connections }
}

/** The secrets given by field key, as the slots of the template's connections. */
export function templateValues(
  template: ConnectionTemplate,
  values: Readonly<Record<string, string>>,
): Outcome<Partial<Record<ConnectionSlot, string>>> {
  const slots: Partial<Record<ConnectionSlot, string>> = {}
  for (const [key, value] of Object.entries(values)) {
    const slot = template.fields.find((field) => field.key === key)?.slot ?? null
    if (slot === null || !KIND_SLOTS[template.kind].includes(slot)) {
      return { error: `${template.title} takes no secret named ${key}` }
    }
    slots[slot] = value
  }
  return slots
}

/** Whether a template answers a search: every word is in its name, description, hosts or APIs. */
export function templateMatches(template: ConnectionTemplate, query: string): boolean {
  const text = [
    template.id,
    template.title,
    template.description,
    template.category,
    ...template.hosts,
    ...template.parts.flatMap((part) => [part.title, ...part.hosts]),
  ]
    .join(' ')
    .toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word))
}
