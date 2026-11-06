import { createContext } from 'react'

/** The viewer header's spot for a file's own actions, which nested views portal into. */
export const ViewerActions = createContext<HTMLElement | null>(null)
