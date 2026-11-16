import { z } from 'zod'
import { lenientArray, orDefault, type ResponseSchema } from './lenient.js'

/** How Seti knows a tool writes or sends: MCP annotations, the tool's name, or not at all. */
export const REVIEW_BASES = ['annotations', 'name', 'unknown'] as const
export type ReviewBasis = (typeof REVIEW_BASES)[number]

/** One tool of an MCP server that writes or sends, or that Seti cannot classify. */
export interface ReviewTool {
  /** The rule that names the tool, as in mcp__slack__send_message. */
  rule: string
  name: string
  basis: ReviewBasis
  /** It changes something outside this machine, so a checklist starts with it selected. */
  outward: boolean
  /** A review rule already holds its calls. */
  reviewed: boolean
}

/** What a review rule's server offers besides the tool the rule names. */
export interface ReviewCoverage {
  /** The rule that names every tool of the server, as in mcp__slack. */
  server: string
  label: string
  /** The tool the asked rule names; null when it names the whole server. */
  tool: string | null
  /** Whether Seti holds the server's tool list; false while the server is not connected. */
  known: boolean
  /** The tools that write or send, and those Seti cannot classify; read-only tools are left out. */
  tools: ReviewTool[]
}

/** A server some of whose tools are reviewed while others that write or send are not. */
export interface ReviewGap {
  server: string
  label: string
  uncovered: number
}

const MCP_NAME = /^mcp__[\w-]+$/

export const reviewCoverageQuery = z.object({
  rule: z.string().trim().max(500).regex(MCP_NAME, 'Use an MCP tool or server, such as mcp__slack__send_message'),
})

const toolSchema = z.object({
  rule: z.string(),
  name: z.string(),
  basis: orDefault<ReviewBasis>('basis', z.enum(REVIEW_BASES), 'unknown'),
  outward: orDefault('outward', z.boolean(), false),
  reviewed: orDefault('reviewed', z.boolean(), false),
}) satisfies ResponseSchema<ReviewTool>

export const reviewCoverageSchema = z.object({
  server: z.string(),
  label: z.string(),
  tool: z.string().nullable(),
  known: orDefault('known', z.boolean(), false),
  tools: lenientArray('review tool', toolSchema),
}) satisfies ResponseSchema<ReviewCoverage>

export const reviewGapSchema = z.object({
  server: z.string(),
  label: z.string(),
  uncovered: z.number(),
}) satisfies ResponseSchema<ReviewGap>
