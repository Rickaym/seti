import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { McpConfigScope, McpServerChange, McpServerRequest } from '@seti/shared'
import { probeEnv } from './capabilities.js'
import { CLAUDE_BIN } from './config.js'
import { HttpError } from './http.js'

const exec = promisify(execFile)

const CLI_TIMEOUT_MS = 60_000

export type RunCli = (args: string[], cwd: string) => Promise<void>

const runClaudeCli: RunCli = async (args, cwd) => {
  await exec(CLAUDE_BIN, args, { cwd, env: probeEnv(), timeout: CLI_TIMEOUT_MS })
}

/** `claude mcp add` arguments: options, then `--`, then positionals, so no value parses as a flag. */
export function addArgs(input: McpServerRequest): string[] {
  const head = ['mcp', 'add', '--scope', input.scope]
  if (input.transport === 'stdio') {
    const env = input.env.flatMap(({ key, value }) => ['-e', `${key}=${value}`])
    return [...head, ...env, '--', input.name, input.command, ...input.args]
  }
  const headers = input.headers.flatMap(({ key, value }) => ['-H', `${key}: ${value}`])
  return [...head, '--transport', input.transport, ...headers, '--', input.name, input.url]
}

export const removeArgs = (name: string, scope: McpConfigScope) => ['mcp', 'remove', '--scope', scope, '--', name]

const secretsOf = (input: McpServerRequest) =>
  (input.transport === 'stdio' ? [...input.env.map((p) => p.value), ...input.args] : input.headers.map((p) => p.value))
    .map((value) => value.trim())
    .filter((value) => value.length >= 3)

function redact(text: string, secrets: string[]): string {
  return secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), text)
}

function cliFailure(e: unknown, secrets: string[]): HttpError {
  const error = e as { code?: unknown; stderr?: unknown; message?: unknown }
  if (error.code === 'ENOENT') {
    return new HttpError(500, `Claude Code CLI not found (${CLAUDE_BIN}); set SETI_CLAUDE_BIN`)
  }
  const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : ''
  const message = typeof error.message === 'string' ? error.message : 'claude mcp failed'
  return new HttpError(400, redact(stderr === '' ? message : stderr, secrets))
}

/** Wraps `claude mcp add|remove`; responses carry the name and scope only, never values. */
export function createMcpConfig(run: RunCli = runClaudeCli) {
  const add = async (input: McpServerRequest, cwd: string): Promise<McpServerChange> => {
    try {
      await run(addArgs(input), cwd)
    } catch (e) {
      throw cliFailure(e, secretsOf(input))
    }
    return { name: input.name, scope: input.scope }
  }

  const remove = async (name: string, scope: McpConfigScope, cwd: string): Promise<McpServerChange> => {
    try {
      await run(removeArgs(name, scope), cwd)
    } catch (e) {
      throw cliFailure(e, [])
    }
    return { name, scope }
  }

  return { add, remove }
}

export const mcpConfig = createMcpConfig()
