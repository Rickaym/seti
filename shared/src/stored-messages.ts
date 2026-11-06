import { z } from 'zod'
import { firstIssue } from './lenient.js'
import { setiControlLevel } from './seti-control.js'
import type { MessageBody } from './tasks.js'

type Schemas = ReadonlyMap<string, z.ZodType>

/** An object whose `field` names its shape; a value `known` lacks only needs the field. */
function tagged(field: string, known: Schemas) {
  return z.looseObject({ [field]: z.string() }).superRefine((value, ctx) => {
    const parsed = known.get(value[field] ?? '')?.safeParse(value)
    for (const issue of parsed?.success === false ? parsed.error.issues : []) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path })
    }
  })
}

const text = z.string()
const parent = z.string().nullish()
const finiteTime = z.number().refine((ms) => Number.isFinite(new Date(ms).getTime()), 'not a time')

const resultParts = z.array(tagged('type', new Map([['text', z.looseObject({ text })]])))

const assistantBlocks = z.array(
  tagged(
    'type',
    new Map<string, z.ZodType>([
      ['text', z.looseObject({ text })],
      ['thinking', z.looseObject({ thinking: text })],
      ['tool_use', z.looseObject({ id: text, name: text })],
    ]),
  ),
)

const userBlocks = z.array(
  tagged(
    'type',
    new Map<string, z.ZodType>([
      ['text', z.looseObject({ text })],
      ['tool_result', z.looseObject({ tool_use_id: text, content: z.union([text, resultParts]).optional() })],
    ]),
  ),
)

const usage = z.looseObject({ total_tokens: z.number(), tool_uses: z.number(), duration_ms: z.number() })

const systemMessage = tagged(
  'subtype',
  new Map<string, z.ZodType>([
    ['init', z.looseObject({ mcp_servers: z.array(z.looseObject({ name: text, status: text })).optional() })],
    ['task_started', z.looseObject({ task_id: text, tool_use_id: text.optional(), description: text })],
    ['task_progress', z.looseObject({ task_id: text, description: text, usage })],
    [
      'task_updated',
      z.looseObject({
        task_id: text,
        patch: z.looseObject({ status: text.optional(), end_time: finiteTime.optional(), error: text.optional() }),
      }),
    ],
    [
      'task_notification',
      z.looseObject({ task_id: text, status: text, summary: text, output_file: text, usage: usage.optional() }),
    ],
  ]),
)

const resultMessage = z
  .looseObject({ subtype: text, is_error: z.boolean(), result: text.optional() })
  .refine((m) => m.subtype !== 'success' || m.result !== undefined, { message: 'missing', path: ['result'] })

const sdkPayload = tagged(
  'type',
  new Map<string, z.ZodType>([
    ['assistant', z.looseObject({ message: z.looseObject({ content: assistantBlocks }), parent_tool_use_id: parent })],
    [
      'user',
      z.looseObject({ message: z.looseObject({ content: z.union([text, userBlocks]) }), parent_tool_use_id: parent }),
    ],
    ['result', resultMessage],
    ['system', systemMessage],
  ]),
)

const promptPayload = z.looseObject({
  text,
  auto: z.boolean().optional(),
  inputs: z.number().optional(),
  interrupted: z.boolean().optional(),
  queued: z.enum(['waiting', 'delivered', 'removed']).optional(),
  retry: z.boolean().optional(),
  attachments: z.array(z.looseObject({ name: text, path: text, reference: text })).optional(),
  client_id: text.optional(),
})

const setiPayload = z.looseObject({
  error: text,
  stopped: z.boolean().optional(),
  session: z.enum(['restarted', 'fresh']).optional(),
  seti_control: z.union([z.boolean(), setiControlLevel]).optional(),
  seti_control_was: setiControlLevel.optional(),
  bypass: z.boolean().optional(),
})

const shellPayload = z.looseObject({
  run_id: text,
  command: text,
  cwd: text,
  exit_code: z.number().nullable(),
  signal: text.nullable(),
  ended_by: z.enum(['timeout', 'user']).nullable(),
  stdout: text,
  stderr: text,
})

const inputPayload = z.looseObject({
  source: z.enum(['pr', 'team', 'workspace', 'channel', 'agent', 'seti']),
  kind: text,
  subject: text,
  title: text,
  body: text,
  url: text.nullable(),
  dismissed_at: text.optional(),
  channel_id: text.optional(),
  task_id: text.optional(),
  subtask: z.looseObject({ tool_use_id: text }).optional(),
})

const noticePayload = z.looseObject({ title: text, body: text })

const PAYLOADS = new Map<string, z.ZodType>([
  ['prompt', promptPayload],
  ['sdk', sdkPayload],
  ['seti', setiPayload],
  ['shell', shellPayload],
  ['input', inputPayload],
  ['notice', noticePayload],
])

export type BodyCheck = { ok: true; body: MessageBody } | { ok: false; reason: string }

/** Checks the fields Seti reads against their types; any other field passes through untouched. */
export function checkMessageBody(kind: string, payload: unknown): BodyCheck {
  const schema = PAYLOADS.get(kind)
  if (schema === undefined) {
    return { ok: false, reason: 'unknown kind' }
  }
  const parsed = schema.safeParse(payload)
  return parsed.success
    ? ({ ok: true, body: { kind, payload } } as { ok: true; body: MessageBody })
    : { ok: false, reason: firstIssue(parsed.error) }
}
