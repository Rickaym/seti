import type { ModPrChipProps } from '@seti/mod-api'
import { Registry } from '@seti/shared'
import type { ComponentType } from 'react'

/** A chip an enabled mod adds beside each open PR in an agent's PR row. */
export interface PrChipEntry {
  key: string
  name: string
  view: ComponentType<ModPrChipProps>
}

export const prChips = new Registry<PrChipEntry>('PR chip', (entry) => entry.key)
