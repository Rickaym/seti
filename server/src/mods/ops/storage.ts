import { MOD_LIMITS } from '@seti/shared'
import { z } from 'zod'
import { defineOp } from './define.js'
import { HttpError } from '../../http.js'
import { ModDataFull, modData } from '../../store/mods.js'

const key = z.string().min(1).max(MOD_LIMITS.storageKeyChars)

/** A mod's own storage: the mod id comes from the call, never from args. */
export const storageOps = {
  'storage.get': defineOp({
    args: z.strictObject({ key }),
    run: async (args, { call }) => modData.get(call.modId, args.key),
  }),
  'storage.keys': defineOp({
    args: z.strictObject({ prefix: z.string().max(MOD_LIMITS.storageKeyChars).optional() }),
    run: async (args, { call }) =>
      (await modData.keys(call.modId))
        .filter((name) => args.prefix === undefined || name.startsWith(args.prefix))
        .slice(0, MOD_LIMITS.storageKeysListed),
  }),
  'storage.set': defineOp({
    args: z.strictObject({ key, value: z.json() }),
    run: async (args, { call }) => {
      await modData.set(call.modId, args.key, args.value).catch((e: unknown) => {
        throw e instanceof ModDataFull ? new HttpError(413, e.message) : e
      })
      return null
    },
  }),
  'storage.delete': defineOp({
    args: z.strictObject({ key }),
    run: async (args, { call }) => {
      await modData.delete(call.modId, args.key)
      return null
    },
  }),
}
