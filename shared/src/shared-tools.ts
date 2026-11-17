import { z } from 'zod'
import { connectionEnv, connectionHost } from './connections.js'

/** The largest script an agent may propose as a shared tool. */
export const SHARED_TOOL_BYTES_MAX = 64 * 1024
const NEEDS_MAX = 5
const HOSTS_MAX = 5
const DESCRIPTION_MAX = 1500

export const sharedToolName = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'Use lowercase letters, digits and hyphens, such as fetch-invoices')

/** A variable the script reads and the hosts it sends it to; the agent never gives its value. */
const sharedToolNeed = z.strictObject({
  env: connectionEnv,
  hosts: z.array(connectionHost).min(1).max(HOSTS_MAX),
})
export type SharedToolNeed = z.output<typeof sharedToolNeed>

/** What an agent proposes: one script of its own, by path, with when and how to use it. */
export const sharedToolProposal = z.strictObject({
  kind: z.literal('shared_tool'),
  name: sharedToolName,
  description: z
    .string()
    .trim()
    .min(20, 'Say when to use it and how to call it')
    .max(DESCRIPTION_MAX)
    .refine((text) => !text.includes('`'), 'Write it without backticks; a skill runs what they quote'),
  path: z.string().trim().min(1).max(1024),
  needs: z
    .array(sharedToolNeed)
    .max(NEEDS_MAX)
    .default([])
    .refine((needs) => new Set(needs.map((need) => need.env)).size === needs.length, 'Name each variable once'),
})
export type SharedToolProposal = z.output<typeof sharedToolProposal>

/** The script as Seti read it when the agent asked, which is exactly what Allow publishes. */
export interface SharedToolSnapshot {
  /** The script's file name, without its folder. */
  file: string
  content: string
  sha256: string
  /** The published version this one replaces, as it was when the agent asked. */
  replaces: { sha256: string; content: string } | null
}

/** A proposal as Seti stores it on the request: the agent's fields and Seti's own snapshot. */
export type SharedToolChange = SharedToolProposal & { snapshot: SharedToolSnapshot }

/** The variables a tool needs that a credential does not carry. */
export const missingNeeds = (needs: readonly SharedToolNeed[], envs: readonly string[]): string[] =>
  needs.map((need) => need.env).filter((env) => !envs.includes(env))

/** What makes a proposal broad, for the card to show before Allow. */
export function sharedToolFlags(change: SharedToolChange): string[] {
  const envs = change.needs.map((need) => need.env)
  const who =
    envs.length === 0
      ? 'Every sandboxed agent will be able to run this'
      : `Every sandboxed agent whose credential has ${envs.join(' and ')} will be able to run this`
  return [who, ...(change.snapshot.replaces === null ? [] : [`Replaces the published ${change.name}`])]
}

/** A published shared tool, without its code. */
export interface SharedTool {
  name: string
  description: string
  file: string
  sha256: string
  bytes: number
  needs: SharedToolNeed[]
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
