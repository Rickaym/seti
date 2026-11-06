import type { LucideIcon } from 'lucide-react'
import { createContext, useContext } from 'react'

export interface ConfirmOptions {
  title?: string
  /** The one fact that matters, read first. */
  message: string
  /** What else changes, under the lead sentence. */
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'destructive'
  /** The confirm button's icon, in place of the one its variant brings. */
  icon?: LucideIcon
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

export const ConfirmContext = createContext<ConfirmFn | null>(null)

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext)
  if (!confirm) {
    throw new Error('useConfirm must be used inside ConfirmProvider')
  }
  return confirm
}
