import { fileChangeInput, HTTPS_PORT, REQUEST_REASON_MAX } from '@seti/shared'
import { z } from 'zod'
import { fileChangeRequest, PENDING_MAX, REQUEST_TTL_MS } from '../change-requests.js'
import { done, setiTool } from './tool.js'

const HOURS = String(REQUEST_TTL_MS / 3_600_000)

const requestChange = setiTool({
  name: 'request_change',
  description:
    'Ask the user for access you lack, with the exact change and why; the user allows or denies it with one ' +
    'tap, and Seti tells you the answer as an update. Kinds: allow_host (a host and port on the network ' +
    `allowlist, ${String(HTTPS_PORT)} by default; the user picks you or every agent), api_key (a connection by ` +
    'its variable name and hosts; the user pastes the key into the request in Seti as they allow it, and you ' +
    'only ever hold a placeholder), mcp_server (an MCP server Seti has, for you). Never ask for a key or ' +
    'token in chat, and never ask for the sandbox off, Bypass, permission rules, secret values or other ' +
    `agents. Carry on with other work or end your turn while it waits; it expires after ${HOURS} hours, and ` +
    `at most ${String(PENDING_MAX)} wait at once.`,
  input: {
    change: fileChangeInput.shape.change.describe(
      'The change: {kind: "allow_host", host, port?}, {kind: "api_key", env, hosts} or {kind: "mcp_server", server}.',
    ),
    reason: z
      .string()
      .trim()
      .max(REQUEST_REASON_MAX)
      .describe('One or two sentences on why you need it, which the user reads before answering.'),
  },
  run: async (args, ctx) => {
    const filed = await fileChangeRequest(ctx.caller, fileChangeInput.parse(args))
    switch (filed.outcome) {
      case 'already':
        return done(filed.text)
      case 'waiting':
        return done('The same request already waits for the user; Seti tells you the answer.')
      case 'filed':
        return { ...done('Filed; the user sees it in Seti now. Seti tells you the answer.'), request: filed.request }
    }
  },
})

/** The tool every agent with Seti control gets for access only the user grants. */
export const REQUEST_TOOLS = [requestChange]
