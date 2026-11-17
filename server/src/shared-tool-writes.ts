const declared = new Map<string, boolean>()

/** Whether a shared tool, by the name agents call it, changes anything outside; else null. */
export const sharedToolWrites = (callName: string): boolean | null => declared.get(callName) ?? null

/** Replaces what the published tools declared, after a tool is published, changed or removed. */
export function declareToolWrites(tools: ReadonlyMap<string, boolean>): void {
  declared.clear()
  for (const [callName, writes] of tools) {
    declared.set(callName, writes)
  }
}
