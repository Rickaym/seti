import { SOURCE_KINDS, sourceLookupQuery, type SourceLookup, type Task } from '@seti/shared'
import { z } from 'zod'
import { lookupSources } from '../sources/lookup.js'
import { ToolRefusal, type ToolContext } from './tool.js'

/** The arguments find_in_transcript takes to search the caller's evidence ledger. */
export const SOURCE_FILTERS = {
  where: z
    .enum(['transcript', 'sources'])
    .default('transcript')
    .describe(
      'sources searches the Slack, Linear and GitHub items you read yourself, with their exact text ' +
        'and permalink, newest first: quote and cite from them rather than from memory.',
    ),
  kind: z.enum(SOURCE_KINDS).optional().describe('With where=sources: only items of this source.'),
  container: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('With where=sources: a channel (#name or id), owner/repo or Linear team key.'),
  since: z.string().trim().min(1).max(40).optional().describe('With where=sources: from this date or ISO time.'),
  until: z.string().trim().min(1).max(40).optional().describe('With where=sources: up to this date or ISO time.'),
}

interface SourceArgs {
  query?: string | undefined
  kind?: (typeof SOURCE_KINDS)[number] | undefined
  container?: string | undefined
  since?: string | undefined
  until?: string | undefined
}

/** The caller's own ledger, searched; an agent never reads another agent's. */
export async function ownSources(ctx: ToolContext, task: Pick<Task, 'id'>, args: SourceArgs): Promise<SourceLookup> {
  if (task.id !== ctx.caller.id) {
    throw new ToolRefusal('where=sources searches only your own sources; name yourself as the task.')
  }
  const { query, ...rest } = args
  return lookupSources(task.id, sourceLookupQuery.parse({ ...rest, q: query }))
}
