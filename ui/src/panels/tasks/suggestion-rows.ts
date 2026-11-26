import type { ComposerCommand, SetiCompletion } from '@seti/shared'

/** One row of the menu under or over the reply box: a command, or a choice for the next word. */
export interface SuggestionRow {
  key: string
  /** What picking it puts in the box. */
  insert: string
  title: string
  hint: string
  detail: string
  /** Why it cannot be picked here; the row shows it muted. */
  unavailable: string | null
}

export const commandRow = (command: ComposerCommand): SuggestionRow => ({
  key: command.name,
  insert: command.name,
  title: `/${command.name}`,
  hint: command.argument_hint,
  detail: command.unsupported === null ? command.description : `Not supported in Seti: ${command.unsupported}`,
  unavailable: null,
})

export const optionRows = (completion: SetiCompletion): SuggestionRow[] =>
  completion.options.map((option) => ({
    key: option.key,
    insert: option.token,
    title: option.label,
    hint: option.current ? 'current' : '',
    detail: option.detail ?? '',
    unavailable: option.unavailable,
  }))
