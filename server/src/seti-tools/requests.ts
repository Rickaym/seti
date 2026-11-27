import { askSecretInput, fileChangeInput, HTTPS_PORT, REQUEST_REASON_MAX } from '@seti/shared'
import { z } from 'zod'
import { fileChangeRequest, PENDING_MAX, REQUEST_TTL_MS } from '../change-requests.js'
import { askSecret } from '../secret-questions.js'
import { done, setiTool } from './tool.js'

const HOURS = String(REQUEST_TTL_MS / 3_600_000)

const requestChange = setiTool({
  name: 'request_change',
  description:
    'Ask the user for access you lack, with the exact change and why, as soon as a task needs it and without ' +
    'searching for another way first; the user allows or denies it with one tap, and Seti tells you the ' +
    'answer as an update. Kinds: allow_host (a host and port on the network ' +
    `allowlist, ${String(HTTPS_PORT)} by default; the user picks you or every agent), api_key (a connection by ` +
    'its variable name and hosts; the user pastes the key into the request in Seti as they allow it, and you ' +
    'only ever hold a placeholder; body true also asks for the value in request bodies, for a login that ' +
    'posts it as JSON or a form, and works for a variable you already have), mcp_server (an MCP server this install has that is off for you, by the ' +
    'name your system prompt or list_mcp_servers gives; your session restarts with its tools for the turn ' +
    'that brings the answer), shared_tool (one script ' +
    'file of yours, at most 64 KB, that proved useful, as a typed tool for every agent: name it, describe ' +
    'what it does, give its arguments as a JSON Schema object in input, say in writes whether it changes or ' +
    'sends anything outside the workspace, and list the variables it reads with their hosts in needs. The ' +
    'script gets its arguments as one JSON object on stdin, prints its result to stdout (JSON if it has ' +
    'structure), and fails with a non-zero exit and a message on stderr; it starts by its #! line, else ' +
    'by its extension, and is stopped after timeout_seconds, 120 unless you set it. Seti reads the file ' +
    'as it is now, the user reviews that code, and once allowed every agent whose credential has those ' +
    'variables gets the tool; the same name again proposes an update), command (a Seti command for ' +
    'yourself, written as the user types it in your reply box, such as /seti:access mcp docs off, ' +
    '/seti:access plugin lint-kit on, /seti:access ssh prod off or /seti:memory 12g; Seti reads it ' +
    'with the same grammar, refuses what it does not define, and the user allows or denies it; you ' +
    'may propose MCP servers, plugins, context packs and hosts on or off, SSH or AWS off, and your ' +
    'own memory or CPU cap). Never ask for a key or ' +
    'token in chat, and never ask for the sandbox off, Bypass, permission rules, secret values or other ' +
    `agents. Carry on with other work or end your turn while it waits; it expires after ${HOURS} hours, and ` +
    `at most ${String(PENDING_MAX)} wait at once.`,
  input: {
    change: fileChangeInput.shape.change.describe(
      'The change: {kind: "allow_host", host, port?}, {kind: "api_key", env, hosts, body?}, {kind: "mcp_server", server} ' +
        'or {kind: "shared_tool", name, description, path, input, writes, timeout_seconds?, needs?: [{env, hosts}]} ' +
        'or {kind: "command", line}.',
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

const askSecretTool = setiTool({
  name: 'ask_secret',
  description:
    'Ask the user for a secret, token or password you need, such as an API key. The call waits until the ' +
    'user enters it in Seti or dismisses it. The value never reaches you or your transcript: outside the ' +
    "sandbox Seti writes it to a file only Seti's user reads and tells you its path; in the sandbox it goes " +
    "to Seti's secret store and the proxy adds it on the hosts you name, so name them. Never ask for a " +
    'secret in your reply or with AskUserQuestion.',
  input: {
    name: askSecretInput.shape.name.describe('The variable-style name, such as AZURE_SPEECH_KEY.'),
    purpose: askSecretInput.shape.purpose.describe('What you need it for, in a sentence the user reads.'),
    hosts: askSecretInput.shape.hosts.describe(
      'The hosts that receive it, such as api.example.com; needed in the sandbox, ignored outside it.',
    ),
  },
  run: async (args, ctx) => askSecret(ctx.caller, askSecretInput.parse(args), ctx.signal),
})

/** The tool every agent with Seti control gets for access only the user grants. */
export const REQUEST_TOOLS = [requestChange]

/** The secret analogue of AskUserQuestion, which every agent gets at any Seti control level. */
export const SECRET_TOOLS = [askSecretTool]
