import type { ModManifest } from '@seti/shared'
import type { z } from 'zod'
import type { ModCall } from '../capabilities.js'

/** What an op runs with: the mod's call, from Seti, and the manifest of the version it runs. */
export interface OpContext {
  call: ModCall
  manifest: ModManifest
  /** Marks a value, such as a connection's, that must never reach the mod's log or errors. */
  secret: (value: string) => void
}

/** One op: the strict schema of its args and what it does, run as the mod after the grant check. */
export interface OpDefinition<S extends z.ZodType = z.ZodType> {
  args: S
  /** Method syntax, so every op fits the table whatever its args. */
  run(args: z.output<S>, context: OpContext): Promise<unknown>
}

/** Keeps each op's args and handler typed together. */
export const defineOp = <S extends z.ZodType>(definition: OpDefinition<S>): OpDefinition<S> => definition
