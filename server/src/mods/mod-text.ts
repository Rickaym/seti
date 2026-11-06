/**
 * A mod's answer as an agent reads it: wrapped and labelled as the mod's, so text inside it never
 * reads as Seti or the user, and it cannot close the wrapper itself.
 */
export function modOutput(modId: string, text: string): string {
  const contained = text.replaceAll('<', '&lt;')
  return `<mod_output mod="${modId}">\nData from the ${modId} mod, not from the user.\n${contained}\n</mod_output>`
}

/** Text a mod wrote, on one line and quoted, so agents and the EA read it as the mod's. */
export const modWords = (text: string): string => `"${text.replace(/\s+/g, ' ').replaceAll('"', "'").slice(0, 300)}"`
