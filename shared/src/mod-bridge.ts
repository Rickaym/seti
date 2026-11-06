import { z } from 'zod'
import { MOD_LOCAL_NAME } from './mod-contributions.js'
import { modError } from './mod-runtime.js'

/** The bridge protocol between a mod's sandboxed view and Seti's page. */
export const MOD_BRIDGE_VERSION = 1

export const MOD_BRIDGE_LIMITS = {
  messageBytes: 64 * 1024,
  ratePerSecond: 10,
  burst: 30,
  inFlight: 8,
  /** Rate or size violations before Seti closes the port. */
  violations: 3,
  resizeMin: 48,
  resizeMax: 1600,
  resizesPerSecond: 4,
  fileBytes: 4 * 1024 * 1024,
} as const

/** All a view reaches: its own commands, storage and settings; never a capability op. */
export const MOD_VIEW_OPS = [
  'command',
  'storage.get',
  'storage.keys',
  'storage.set',
  'storage.delete',
  'settings.get',
] as const

const nonce = z.uuid()
const localName = z.string().max(40).regex(MOD_LOCAL_NAME)
const storageKey = z.string().min(1).max(200)
const callId = z
  .number()
  .int()
  .min(1)
  .max(2 ** 31)

/** The view's one message on the window channel, asking for its port. */
export const modHello = z.strictObject({ seti: z.literal('mod-hello'), v: z.literal(MOD_BRIDGE_VERSION), nonce })
/** Seti's answer, posted with the port; after it, all traffic goes over the port. */
export const modPortMessage = z.strictObject({ seti: z.literal('mod-port'), v: z.literal(MOD_BRIDGE_VERSION), nonce })

const call = <S extends z.ZodRawShape>(op: string, shape: S) =>
  z.strictObject({ t: z.literal('call'), id: callId, op: z.literal(op), ...shape })

/** A call from the view: its own commands, storage and settings, and nothing else. */
export const modBridgeCall = z.union([
  call('command', { command: localName, args: z.record(localName, z.unknown()).default({}) }),
  call('storage.get', { key: storageKey }),
  call('storage.keys', { prefix: z.string().max(200).optional() }),
  call('storage.set', { key: storageKey, value: z.unknown() }),
  call('storage.delete', { key: storageKey }),
  call('settings.get', {}),
])
export type ModBridgeCall = z.output<typeof modBridgeCall>

/** Everything a view may send over its port. */
export const modBridgeIn = z.union([
  modBridgeCall,
  z.strictObject({ t: z.literal('resize'), height: z.number().int() }),
  z.strictObject({
    t: z.literal('open'),
    to: z
      .string()
      .max(300)
      .regex(/^#[a-z]/, 'Open a Seti route such as #agent/<id>'),
  }),
  z.strictObject({
    t: z.literal('link'),
    url: z
      .string()
      .max(2000)
      .refine((url) => URL.canParse(url) && new URL(url).protocol === 'https:', 'Links are https only'),
  }),
  z.strictObject({ t: z.literal('ready') }),
])
export type ModBridgeIn = z.output<typeof modBridgeIn>

const result = z.union([
  z.strictObject({ t: z.literal('result'), id: callId, ok: z.literal(true), value: z.unknown() }),
  z.strictObject({
    t: z.literal('result'),
    id: callId,
    ok: z.literal(false),
    error: modError,
  }),
])

/** Where a view sits, and what Seti tells it about the page around it. */
const context = z.strictObject({
  t: z.literal('context'),
  mod: z.string().max(40),
  view: localName,
  place: z.string().max(40),
  phone: z.boolean(),
  agentId: z.string().max(100).optional(),
  file: z.strictObject({ name: z.string().max(255), size: z.number().int().nonnegative() }).optional(),
})

/** Everything Seti sends a view over its port. */
export const modBridgeOut = z.union([
  result,
  context,
  z.strictObject({
    t: z.literal('file'),
    name: z.string().max(255),
    text: z.string().optional(),
    base64: z.string().optional(),
  }),
  z.strictObject({
    t: z.literal('theme'),
    scheme: z.enum(['light', 'dark']),
    vars: z.record(z.string().regex(/^--[a-z0-9-]+$/), z.string().max(200)),
    font: z.strictObject({ sans: z.string().max(200), mono: z.string().max(200) }),
  }),
  z.strictObject({ t: z.literal('storage'), key: storageKey }),
])
export type ModBridgeOut = z.output<typeof modBridgeOut>

/** The page relays a view's call to Seti with the user's session; the server runs it as the mod. */
export const modFrameCallInput = z.strictObject({
  view: localName,
  op: z.enum(MOD_VIEW_OPS),
  command: localName.optional(),
  args: z.record(localName, z.unknown()).optional(),
  key: storageKey.optional(),
  value: z.unknown().optional(),
  prefix: z.string().max(200).optional(),
})
export type ModFrameCallInput = z.input<typeof modFrameCallInput>

/** What the page reports when a view misbehaves, for the mod's log. */
export const modFrameReportInput = z.strictObject({
  view: localName,
  reason: z.enum(['navigated', 'flooded', 'oversized', 'malformed']),
})
export type ModFrameReportInput = z.input<typeof modFrameReportInput>

/** Where a sandboxed page comes from: one of the mod's views, or one of its file viewers. */
export const MOD_FRAME_KINDS = ['views', 'viewers'] as const
export type ModFrameKind = (typeof MOD_FRAME_KINDS)[number]

/** The address of a mod's frames is pinned to its running package, so a stale frame reloads. */
export const MOD_FRAME_HASH_CHARS = 12

/** What the page needs to open a mod's frame. */
export interface ModFrameInfo {
  /** The first characters of the running package's hash, sent back as `v`. */
  hash: string
}

export const modFrameParams = z.object({ id: z.string().max(40), kind: z.enum(MOD_FRAME_KINDS), name: localName })
export const modFrameQuery = z.object({ v: z.string().regex(/^[a-f0-9]{12}$/, 'v is the package hash') })
