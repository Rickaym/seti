import { z } from 'zod'

/** A name inside a mod: a command, setting, kind or view; Seti prefixes it with the mod's id. */
export const MOD_LOCAL_NAME = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/

export const localName = z.string().max(40).regex(MOD_LOCAL_NAME, 'Use lowercase letters, digits, - and _')
export const title = z.string().trim().min(1).max(60)
