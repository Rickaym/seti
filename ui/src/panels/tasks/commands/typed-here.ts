/** A line runs at Enter only when the user's own keys or taps put this exact text in the box. */
export const typedHere = (trusted: boolean, typed: string | null, draft: string) => trusted && typed === draft
