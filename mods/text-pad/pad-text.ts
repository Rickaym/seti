/** The most characters the pad holds, which keeps it inside one stored value of a mod. */
export const PAD_MAX = 20_000

/** What one stored value may take, a little under the mod store's 64 KB for its own framing. */
const STORED_BYTES_MAX = 60 * 1024

/** Whether the pad is past its length, or past what the store keeps once written out as JSON. */
export const padTooLong = (text: string) =>
  text.length > PAD_MAX || new TextEncoder().encode(JSON.stringify(text)).length > STORED_BYTES_MAX

/** The pad with one more line at its end. */
export function withLine(text: string, line: string): string {
  if (text === '') {
    return line
  }
  return text.endsWith('\n') ? `${text}${line}` : `${text}\n${line}`
}
