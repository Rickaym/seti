/** Patterns in a raw MCP connection error, each with what it means in plain words. */
const CAUSES: [pattern: RegExp, plain: string][] = [
  [
    /ECONNREFUSED|connection refused/i,
    'Nothing answers at the server address. Start the server or check its URL and port.',
  ],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, 'The server host name does not resolve. Check the URL.'],
  [/ETIMEDOUT|timed? ?out/i, 'The server did not answer in time.'],
  [/ENOENT|command not found|spawn/i, 'The server command was not found. Check that it is installed and on the PATH.'],
  [/\b401\b|unauthori[sz]ed/i, 'The server refused the credentials. Sign in again or check its token.'],
  [/\b403\b|forbidden/i, 'The server denied access with these credentials.'],
  [/\b404\b|not found/i, 'Nothing is at that URL. Check the server path.'],
  [/certificate|self[- ]signed|CERT_/i, 'The server TLS certificate is not trusted.'],
  [/EACCES|permission denied/i, 'The server command is not allowed to run. Check its file permissions.'],
  [/exit(ed)?( with)? code|exited/i, 'The server process exited while starting.'],
]

/** One plain sentence for a raw MCP connection error, with a generic one when no cause matches. */
export function explainMcpError(raw: string): string {
  return CAUSES.find(([pattern]) => pattern.test(raw))?.[1] ?? 'The server failed to connect.'
}
