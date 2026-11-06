import { agentActivityQuery, transcriptWindowQuery } from '@seti/shared'
import { z } from 'zod'
import { agentActivity, readTranscript } from '../history.js'
import { anyTask, taskRef } from './refs.js'
import { setiTool } from './tool.js'

const since = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe('Start: today, yesterday, a date such as 2026-10-27, or an ISO time. A date is local to the user.')
const until = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe('End, same forms; a date includes that whole day, so since=until=2026-10-27 reads that day.')
const timezone = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("IANA timezone for dates, such as Europe/Berlin; left out, the user's timezone as Seti knows it.")

const readTranscriptTool = setiTool({
  name: 'read_transcript',
  description:
    "Read what one agent did in a time window (yesterday, a date, a time range): its condensed transcript history, user prompts and agent replies with timestamps, newest lines kept, oldest first. include_tools adds tool calls, shell runs and Seti's notes. Pass older_cursor back as cursor to page further back. Archived agents too.",
  input: {
    task: taskRef,
    since,
    until,
    timezone,
    include_tools: z.boolean().default(false),
    limit: transcriptWindowQuery.shape.limit.describe('Most lines to return, 1 to 200; default 50.'),
    cursor: transcriptWindowQuery.shape.cursor.describe('older_cursor from the previous call, to read older lines.'),
  },
  run: async ({ task: ref, ...query }) => readTranscript(await anyTask(ref), query),
})

const agentActivityTool = setiTool({
  name: 'agent_activity',
  description:
    'What happened in a time window across all agents (what did I do yesterday, today, on a date): every agent with turns in it, most active first, with prompt and reply counts, first and last activity, PRs linked and its last reply. since defaults to today. Follow up with read_transcript on one agent.',
  input: {
    since,
    until,
    timezone,
    limit: agentActivityQuery.shape.limit.describe('Most agents to list, 1 to 100; default 30.'),
  },
  run: async (query) => agentActivity(query),
})

export const HISTORY_TOOLS = [agentActivityTool, readTranscriptTool]
