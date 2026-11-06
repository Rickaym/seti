import { zValidator } from '@hono/zod-validator'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { type z } from 'zod'

export const ok = (c: Context, data: unknown, meta: Record<string, unknown> = {}) => c.json({ data, meta })

export const fail = (c: Context, status: ContentfulStatusCode, title: string, detail: string = title) =>
  c.json({ error: { title, detail } }, status)

export class HttpError extends Error {
  readonly status: ContentfulStatusCode

  constructor(status: ContentfulStatusCode, message: string) {
    super(message)
    this.status = status
  }
}

/** One plain `path: message` entry per issue, so API errors stay readable ASCII. */
export const describeIssues = (error: z.core.$ZodError) =>
  error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.')
      return path === '' ? issue.message : `${path}: ${issue.message}`
    })
    .join('; ')

export const valid = <T extends z.ZodType>(target: 'json' | 'query' | 'param', schema: T) =>
  zValidator(target, schema, (result, c) =>
    result.success ? undefined : fail(c, 400, 'Invalid request', describeIssues(result.error)),
  )

export const validJson = <T extends z.ZodType>(schema: T) => valid('json', schema)
