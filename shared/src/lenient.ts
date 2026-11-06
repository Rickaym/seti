import { z } from 'zod'

/** Repairs the running `parseLenient` made; null outside one. */
let repairs: string[] | null = null

interface Issues {
  issues: readonly { path?: readonly PropertyKey[] | undefined; message?: string | undefined }[]
}

/** The first problem zod found, as `path: message`. */
export const firstIssue = (error: Issues) => {
  const [issue] = error.issues
  if (issue === undefined) {
    return 'invalid'
  }
  const message = issue.message ?? 'invalid'
  const path = issue.path ?? []
  return path.length === 0 ? message : `${path.map(String).join('.')}: ${message}`
}

/** True for any non-null object, the least a nested record must be for the UI to read it. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The field as `schema` reads it, or `fallback` when it does not match; the repair is reported. */
export function orDefault<T>(label: string, schema: z.ZodType<T>, fallback: T): z.ZodType<T> {
  return schema.catch((ctx) => {
    repairs?.push(`${label} (${firstIssue({ issues: ctx.issues })}), used a default`)
    return fallback
  })
}

/** The items that match `item`; each one that does not is dropped and reported. */
export function lenientArray<T>(label: string, item: z.ZodType<T>): z.ZodType<T[]> {
  return orDefault(
    label,
    z.array(z.unknown()).transform((values) =>
      values.flatMap((value) => {
        const parsed = item.safeParse(value)
        if (parsed.success) {
          return [parsed.data]
        }
        repairs?.push(`${label} (${firstIssue(parsed.error)}), dropped one`)
        return []
      }),
    ),
    [],
  )
}

/** A nested shape the UI only passes along: any object or null; anything else reads as null. */
export const opaque = <T>(label: string) =>
  orDefault<T | null>(
    label,
    z.custom<T | null>((value) => value === null || isRecord(value)),
    null,
  )

export type ResponseSchema<T> = z.ZodType<T>

export type LenientResult<T> = { ok: true; data: T; repairs: string[] } | { ok: false; error: string }

/** Reads a body leniently; it fails only when the body's outer shape is wrong. */
export function parseLenient<T>(schema: ResponseSchema<T>, value: unknown): LenientResult<T> {
  const outer = repairs
  const made: string[] = []
  repairs = made
  try {
    const parsed = schema.safeParse(value)
    return parsed.success
      ? { ok: true, data: parsed.data, repairs: made }
      : { ok: false, error: firstIssue(parsed.error) }
  } finally {
    repairs = outer
  }
}
