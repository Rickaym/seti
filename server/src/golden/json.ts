const escape = (char: string) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`

/** Indented JSON with every character outside printable ASCII escaped, for a tracked golden file. */
export const asciiJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2).replace(/[^\n\x20-\x7e]/g, escape)}\n`
