import { z } from 'zod'

const MAX_CONTEXT_CHARS = 1_000_000

export interface ContextFile {
  key: string
  group: string
  label: string
  path: string
  exists: boolean
  size: number | null
  modified_at: string | null
}

export interface ContextFileContent extends ContextFile {
  content: string
  hash: string | null
}

export const writeContextFileInput = z.object({
  content: z.string().max(MAX_CONTEXT_CHARS),
  base_hash: z.string().nullable(),
})
export type WriteContextFileInput = z.infer<typeof writeContextFileInput>

/** Reference packs are material an agent may consult; a role pack is its standing role. */
export const PACK_KINDS = ['reference', 'role'] as const
export type PackKind = (typeof PACK_KINDS)[number]

/** A pack's editable fields; its kind is fixed once it exists. */
export const contextPackInput = z.object({
  name: z.string().trim().min(1, 'name is required').max(80),
  description: z.string().trim().max(500).default(''),
  body: z.string().max(MAX_CONTEXT_CHARS),
})
export type ContextPackInput = z.input<typeof contextPackInput>

export const newContextPackInput = contextPackInput.extend({ kind: z.enum(PACK_KINDS).default('reference') })
export type NewContextPackInput = z.input<typeof newContextPackInput>

export interface ContextPack {
  id: string
  name: string
  description: string
  body: string
  /** An agent links at most one role pack, never by default; it follows the Seti guide. */
  kind: PackKind
  /** Seti's own pack: read-only, its body rendered by Seti for each agent. */
  builtin: boolean
  /** Linked to new agents unless they pick their packs themselves. */
  linked_by_default: boolean
  created_at: string
  updated_at: string
}

export const contextPackDefaultInput = z.object({ linked_by_default: z.boolean() })
export type ContextPackDefaultInput = z.infer<typeof contextPackDefaultInput>

export type ContextPackSummary = Pick<ContextPack, 'id' | 'name' | 'kind'>

/** The packs an agent or the EA links, replacing the ones it links now. */
export const taskContextPacksInput = z.object({
  pack_ids: z.array(z.uuid()),
})
export type TaskContextPacksInput = z.infer<typeof taskContextPacksInput>

/** The role pack an agent or the EA links in place of its current one; null leaves it without. */
export const taskRoleInput = z.object({ pack_id: z.uuid().nullable() })
export type TaskRoleInput = z.infer<typeof taskRoleInput>

/** The most pack text the EA's system prompt takes after its base prompt; the rest is cut. */
export const EA_PACK_CHARS_MAX = 8_000

/** The pack text the EA adds to its base prompt: its role, then its reference packs. */
export interface EaPackPrompt {
  /** Cut at max_chars when the linked packs run longer. */
  text: string
  /** The length of the linked packs' text before any cut. */
  chars: number
  max_chars: number
  /** The actions of the mods that are on, which the EA runs with run_mod_action; empty for none. */
  mod_actions: string
  /** What the EA calls the user now and then, from its settings; empty for no title. */
  form_of_address: string
}

/** Who reads a pack: the agents it is linked to, archived ones aside, and the EA. */
export interface ContextPackLinks {
  agents: { id: string; title: string }[]
  ea: boolean
}
