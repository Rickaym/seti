import { z } from 'zod'
import { connectionEnv, connectionHost, hostMatches } from './connections.js'

/** The largest script an agent may propose as a shared tool. */
export const SHARED_TOOL_BYTES_MAX = 64 * 1024
/** The MCP server that offers shared tools, so a tool reads `mcp__shared__<name>`. */
export const SHARED_TOOL_SERVER = 'shared'
export const SHARED_TOOL_TIMEOUT_DEFAULT = 120
const TIMEOUT_MAX = 600
const NEEDS_MAX = 5
const HOSTS_MAX = 5
const DESCRIPTION_MAX = 1500
const INPUT_BYTES_MAX = 8 * 1024
const INPUT_DEPTH_MAX = 4
const PROPERTIES_MAX = 30
const ENUM_MAX = 50

export const sharedToolName = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'Use lowercase letters, digits and hyphens, such as fetch-invoices')

/** The name an agent calls the tool by. */
export const sharedToolCallName = (name: string) => `mcp__${SHARED_TOOL_SERVER}__${name}`

/** A variable the script reads and the hosts it sends it to; the agent never gives its value. */
const sharedToolNeed = z.strictObject({
  env: connectionEnv,
  hosts: z.array(connectionHost).min(1).max(HOSTS_MAX),
})
export type SharedToolNeed = z.output<typeof sharedToolNeed>

const INPUT_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'] as const

/** One argument, or a value inside one: the part of JSON Schema a shared tool may use. */
export interface ToolInputProperty {
  type: (typeof INPUT_TYPES)[number]
  description?: string | undefined
  enum?: (string | number)[] | undefined
  items?: ToolInputProperty | undefined
  properties?: Record<string, ToolInputProperty> | undefined
  required?: string[] | undefined
}

const propertyName = z.string().regex(/^[A-Za-z_]\w{0,63}$/, 'Name arguments with letters, digits and underscores')

const namesProperties = (value: {
  properties?: Record<string, unknown> | undefined
  required?: string[] | undefined
}) => (value.required ?? []).every((name) => name in (value.properties ?? {}))

/** Strict, so `$ref`, remote references and every keyword outside this subset are refused. */
const toolInputProperty: z.ZodType<ToolInputProperty> = z.lazy(() =>
  z
    .strictObject({
      type: z.enum(INPUT_TYPES),
      description: z.string().max(500).optional(),
      enum: z
        .array(z.union([z.string().max(200), z.number()]))
        .min(1)
        .max(ENUM_MAX)
        .optional(),
      items: toolInputProperty.optional(),
      properties: z
        .record(propertyName, toolInputProperty)
        .refine((value) => Object.keys(value).length <= PROPERTIES_MAX, 'Too many properties')
        .optional(),
      required: z.array(propertyName).max(PROPERTIES_MAX).optional(),
    })
    .refine(namesProperties, 'required names a property that is not declared'),
)

function depthOf(property: Pick<ToolInputProperty, 'properties' | 'items'>): number {
  const inner = [...Object.values(property.properties ?? {}), ...(property.items === undefined ? [] : [property.items])]
  return 1 + Math.max(0, ...inner.map(depthOf))
}

/** The arguments of a shared tool: a JSON Schema object of typed, described properties. */
export const toolInput = z
  .strictObject({
    type: z.literal('object'),
    properties: z
      .record(propertyName, toolInputProperty)
      .refine((value) => Object.keys(value).length <= PROPERTIES_MAX, 'Too many properties')
      .default({}),
    required: z.array(propertyName).max(PROPERTIES_MAX).default([]),
  })
  .refine(namesProperties, 'required names a property that is not declared')
  .refine((input) => depthOf(input) <= INPUT_DEPTH_MAX, `Nest arguments at most ${String(INPUT_DEPTH_MAX)} deep`)
  .refine((input) => JSON.stringify(input).length <= INPUT_BYTES_MAX, 'The argument schema is too large')
export type ToolInput = z.output<typeof toolInput>

/** What an agent proposes: one script of its own, by path, with its arguments and what it does. */
export const sharedToolProposal = z.strictObject({
  kind: z.literal('shared_tool'),
  name: sharedToolName,
  description: z.string().trim().min(20, 'Say what it does and when to use it').max(DESCRIPTION_MAX),
  path: z.string().trim().min(1).max(1024),
  input: toolInput,
  writes: z.boolean(),
  timeout_seconds: z.number().int().min(1).max(TIMEOUT_MAX).default(SHARED_TOOL_TIMEOUT_DEFAULT),
  needs: z
    .array(sharedToolNeed)
    .max(NEEDS_MAX)
    .default([])
    .refine((needs) => new Set(needs.map((need) => need.env)).size === needs.length, 'Name each variable once'),
})
export type SharedToolProposal = z.output<typeof sharedToolProposal>

/** Everything about a tool except its code: what agents see and what the user reviews. */
export interface SharedToolDefinition {
  name: string
  description: string
  input: ToolInput
  /** Whether it changes or sends anything outside the agent's workspace. */
  writes: boolean
  timeout_seconds: number
  needs: SharedToolNeed[]
  /** The script's file name, without its folder. */
  file: string
}

/** The definition as the tool's folder holds it, with the program that starts the script. */
export type SharedToolManifest = SharedToolDefinition & { run: string[] }

/** Only the definition's own fields, in one fixed order, whatever else the value carries. */
export function toolDefinition(tool: SharedToolDefinition): SharedToolDefinition {
  const { name, description, input, writes, timeout_seconds, needs, file } = tool
  return { name, description, input, writes, timeout_seconds, needs, file }
}

/** The definition as text, for the hash and for the diff of an update. */
export const definitionText = (tool: SharedToolDefinition) => JSON.stringify(toolDefinition(tool), null, 2)

/** The tool as Seti read it when the agent asked, which is exactly what Allow publishes. */
export interface SharedToolSnapshot {
  file: string
  content: string
  /** The hash of the definition and the script together. */
  sha256: string
  /** The published version this one replaces, as it was when the agent asked. */
  replaces: { sha256: string; content: string; definition: string } | null
}

/** A proposal as Seti stores it on the request: the agent's fields and Seti's own snapshot. */
export type SharedToolChange = SharedToolProposal & { snapshot: SharedToolSnapshot }

/** The definition a proposal publishes. */
export const proposedDefinition = (change: SharedToolChange): SharedToolDefinition => ({
  name: change.name,
  description: change.description,
  input: change.input,
  writes: change.writes,
  timeout_seconds: change.timeout_seconds,
  needs: change.needs,
  file: change.snapshot.file,
})

/** A connection of an agent's credential: its variable and the hosts its value goes to. */
export interface CarriedConnection {
  env: string
  hosts: readonly string[]
}

const covered = (host: string, hosts: readonly string[]) =>
  hosts.some((pattern) => pattern === host || hostMatches(pattern, host))

/**
 * The variables a tool needs that a credential does not carry on the hosts the tool names: there
 * a script would send a placeholder the proxy never swaps.
 */
export function missingNeeds(needs: readonly SharedToolNeed[], carried: readonly CarriedConnection[]): string[] {
  return needs
    .filter((need) => {
      const connection = carried.find((entry) => entry.env === need.env)
      return connection === undefined || !need.hosts.every((host) => covered(host, connection.hosts))
    })
    .map((need) => need.env)
}

/** What makes a proposal broad, for the card to show before Allow. */
export function sharedToolFlags(change: SharedToolChange): string[] {
  const envs = change.needs.map((need) => need.env)
  const who =
    envs.length === 0
      ? 'Every agent will be able to run this'
      : `Every agent whose credential has ${envs.join(' and ')} will be able to run this`
  return [
    who,
    'An agent without the sandbox runs it with your access to this machine',
    ...(change.snapshot.replaces === null ? [] : [`Replaces the published ${change.name}`]),
  ]
}

/** A published shared tool, without its code. */
export interface SharedTool extends SharedToolDefinition {
  sha256: string
  bytes: number
  enabled: boolean
  /** The agent that proposed the published version; null once that agent is deleted. */
  proposer_task_id: string | null
  proposer_title: string
  created_at: string
  updated_at: string
}

export type SharedToolCode = SharedTool & { content: string }

export const sharedToolParams = z.object({ name: sharedToolName })
export const sharedToolUpdateInput = z.object({ enabled: z.boolean() })
