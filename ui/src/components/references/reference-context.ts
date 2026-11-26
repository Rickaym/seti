import { createContext, useContext } from 'react'
import type { ExtraProps } from 'react-markdown'
import { referenceOf, REF_PROPERTY, type Reference, type ReferenceSet } from '@/lib/references/reference-set'

/** The references of the message being rendered; null where Markdown renders none. */
export const ReferencesContext = createContext<ReferenceSet | null>(null)

/** The reference a rendered node is tied to, or null. */
export function useReferenceOf(node: ExtraProps['node']): Reference | null {
  return referenceOf(useContext(ReferencesContext), node?.properties[REF_PROPERTY])
}

export const INLINE_LINK = 'text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary'
