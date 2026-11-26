import { z } from 'zod'
import { eaReason } from './mod-ea-reach.js'
import { localName } from './mod-names.js'

/** A route under /api/mods/<id>/; only routes marked demo answer in the public demo. */
export const modRoute = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z
    .string()
    .max(120)
    .regex(/^(?:\/(?:[a-z0-9-]+|:[a-z][a-z0-9_]*))+$/, 'A route path is /segments of lowercase words or :params')
    .refine((path) => !/^\/actions(?:\/|$)/.test(path), 'Seti runs commands under /actions'),
  demo: z.boolean().default(false),
  /** It answers with server-sent events, written as the handler goes. */
  stream: z.boolean().default(false),
  /** The command that does the same, so the EA reaches what this route changes. */
  command: localName.optional(),
  eaReason,
})

export const modPublicPath = z.strictObject({
  path: z
    .string()
    .max(120)
    .regex(/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/, 'A public path is exact, with no parameters'),
})
