import { z } from 'zod'
import type { ServiceIconKey } from './service-icons.js'

const headerName = z
  .string()
  .trim()
  .max(60)
  .regex(/^[A-Za-z][A-Za-z0-9-]*$/, 'A header name is letters, digits and -, such as X-Signature')

/** A dot path into the JSON body, such as data.title; a number picks an array entry. */
export const senderPath = z
  .string()
  .trim()
  .max(120)
  .regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+){0,7}$/, 'A dot path such as data.title')

const fromHeader = z.strictObject({ in: z.literal('header'), name: headerName })
const fromBody = z.strictObject({ in: z.literal('body'), name: senderPath })
/** One `key=value` part of the signature header itself, such as t in Stripe's t=..,v1=... */
const fromSignature = z.strictObject({
  in: z.literal('signature'),
  name: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{1,16}$/, 'A key of the signature header, such as t'),
})

/** Where a delivery keeps one value: a header, or a field of its JSON body. */
const senderSource = z.discriminatedUnion('in', [fromHeader, fromBody])
export type SenderSource = z.output<typeof senderSource>

const timestampSource = z.discriminatedUnion('in', [fromHeader, fromBody, fromSignature])
export type SenderTimestampSource = z.output<typeof timestampSource>

/** What a sender signs: the raw body alone, or the body after its timestamp and delivery id. */
export const SENDER_SIGNED = [
  '{body}',
  '{timestamp}.{body}',
  'v0:{timestamp}:{body}',
  '{id}.{timestamp}.{body}',
] as const
export type SenderSigned = (typeof SENDER_SIGNED)[number]

export const SENDER_ALGORITHMS = ['sha256', 'sha1', 'sha512'] as const
export const SENDER_ENCODINGS = ['hex', 'base64'] as const
/** How a header holds several signatures: one only, or a list split by commas or spaces. */
export const SENDER_SEPARATORS = ['none', 'comma', 'space'] as const
/** text: the secret's characters are the key; base64: its base64 bytes, after any whsec_. */
export const SENDER_KEYS = ['text', 'base64'] as const

const prefix = z
  .string()
  .max(20)
  .regex(/^[\w=:, -]*$/, 'A prefix such as sha256= or v1=')
  .default('')

const hmacSignature = z.strictObject({
  scheme: z.literal('hmac'),
  header: headerName,
  algorithm: z.enum(SENDER_ALGORITHMS).default('sha256'),
  encoding: z.enum(SENDER_ENCODINGS).default('hex'),
  /** What each signature starts with, such as sha256= or v1=; entries without it are skipped. */
  prefix,
  separator: z.enum(SENDER_SEPARATORS).default('none'),
  signed: z.enum(SENDER_SIGNED).default('{body}'),
  key: z.enum(SENDER_KEYS).default('text'),
})

/** A sender that cannot sign sends the secret itself in a header, after an optional prefix. */
const tokenSignature = z.strictObject({ scheme: z.literal('token'), header: headerName, prefix })

const signature = z.discriminatedUnion('scheme', [hmacSignature, tokenSignature])
export type SenderSignature = z.output<typeof signature>

const paths = z.array(senderPath).max(4).default([])

/** Answers a sender's signed URL check by sending back one field of it, as Slack asks. */
const handshake = z.strictObject({
  /** The field that marks the check, and the value it holds then. */
  path: senderPath,
  equals: z.string().trim().min(1).max(60),
  /** The field whose text Seti sends back. */
  echo: senderPath,
})

export const SENDER_MAX_AGE_S = { min: 30, max: 86_400, default: 300 } as const
export const SENDER_DETAIL_MAX = { max: 2000, default: 1000 } as const

const needs = (signed: SenderSigned, part: 'timestamp' | 'id') => signed.includes(`{${part}}`)

/** How Seti verifies one app's deliveries and reads an event from them, as data alone. */
export const senderDefinition = z
  .strictObject({
    signature,
    /** When the delivery was sent; Seti refuses one older than max_age_s. */
    timestamp: timestampSource.nullable().default(null),
    /** The sender's id of the delivery; Seti takes each id once a day. */
    id: senderSource.nullable().default(null),
    max_age_s: z.number().int().min(SENDER_MAX_AGE_S.min).max(SENDER_MAX_AGE_S.max).default(SENDER_MAX_AGE_S.default),
    /** generated: Seti makes the secret; sender: the app issues it and the user pastes it in. */
    secret: z.enum(['generated', 'sender']).default('sender'),
    /** The event's name, which subscriptions filter on, and a field appended after a dot. */
    event: senderSource.nullable().default(null),
    action: senderPath.nullable().default(null),
    /** Fields tried in order for the update's title, link and text. */
    title: paths,
    link: paths,
    detail: paths,
    /** How much of the text, or of the payload when no detail field holds any, is passed on. */
    detail_max: z.number().int().min(0).max(SENDER_DETAIL_MAX.max).default(SENDER_DETAIL_MAX.default),
    handshake: handshake.nullable().default(null),
  })
  .superRefine((definition, context) => {
    const { signature: sig, timestamp, id } = definition
    const signed = sig.scheme === 'hmac' ? sig.signed : '{body}'
    if (needs(signed, 'timestamp') && timestamp === null) {
      context.addIssue({ code: 'custom', path: ['timestamp'], message: 'Say where the signed timestamp is' })
    }
    if (needs(signed, 'id') && id === null) {
      context.addIssue({ code: 'custom', path: ['id'], message: 'Say where the signed delivery id is' })
    }
    if (timestamp?.in === 'signature' && (sig.scheme !== 'hmac' || sig.separator === 'none')) {
      const message = 'A timestamp inside the signature header needs a comma or space separated list'
      context.addIssue({ code: 'custom', path: ['timestamp'], message })
    }
  })
export type SenderDefinition = z.output<typeof senderDefinition>
export type SenderDefinitionInput = z.input<typeof senderDefinition>

/** A named app whose deliveries Seti takes: what the user reads and the definition. */
export interface WebhookSender {
  id: string
  title: string
  description: string
  /** The brand mark beside its name; a webhook icon stands in when null. */
  icon: ServiceIconKey | null
  /** The app's own page on signing its webhooks. */
  docs: string
  /** What the app calls the secret, such as Signing secret. */
  secret_label: string
  /** Where in the app the URL goes and where the secret is, in two or three short lines. */
  steps: string[]
  /** Event kinds the app reports, offered when filtering a subscription. */
  kinds: string[]
  definition: SenderDefinition
}

/** The source id of a webhook whose sender the user described; its definition is the channel's. */
export const CUSTOM_WEBHOOK_SOURCE = 'custom'

/** The header a definition verifies, as a card names it. */
export const senderHeader = (definition: SenderDefinition) => definition.signature.header

/** A pasted request, checked with a sender's definition and a secret, without storing anything. */
export const senderSampleInput = z
  .strictObject({
    /** The webhook whose sender and sealed secret check the sample. */
    channel_id: z.string().max(40).optional(),
    /** Or a catalog sender or a definition, with the secret typed beside it. */
    preset: z.string().max(82).optional(),
    definition: senderDefinition.optional(),
    secret: z.string().trim().min(1).max(256).optional(),
    /** The request's headers as copied, one `Name: value` a line. */
    headers: z.string().max(16_384),
    body: z.string().max(256 * 1024),
  })
  .refine(
    (input) => (input.channel_id === undefined) !== (input.preset === undefined && input.definition === undefined),
    'Name a webhook, or a sender with its secret',
  )
export type SenderSampleInput = z.input<typeof senderSampleInput>

/** What a pasted request would do: whether it verifies, and the update it would make. */
export interface SenderSampleResult {
  verified: boolean
  /** Why it does not verify, or what a live delivery like it would still be refused for. */
  reason: string
  event: { kind: string; title: string; url: string | null } | null
}
