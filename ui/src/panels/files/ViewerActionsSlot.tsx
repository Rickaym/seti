import { useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ViewerActions } from '@/panels/files/viewer-actions'

/** Puts its children in the open file's header, beside Edit and Download. */
export function ViewerActionsSlot({ children }: { children: ReactNode }) {
  const target = useContext(ViewerActions)
  return target === null ? null : createPortal(children, target)
}
