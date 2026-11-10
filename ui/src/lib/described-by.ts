/** The ids of what describes a control, or undefined when nothing does. */
export function describedBy(...ids: (string | false)[]): string | undefined {
  const named = ids.filter((id) => id !== false)
  return named.length === 0 ? undefined : named.join(' ')
}
