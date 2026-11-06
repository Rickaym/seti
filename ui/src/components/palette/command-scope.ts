import { createContext, useContext } from 'react'

/** False in an unfocused agent frame, whose palette commands, find and Esc stay off. */
export const CommandScope = createContext(true)

export const useCommandScope = (): boolean => useContext(CommandScope)
