import type { SandboxPolicy, SandboxStatus } from '@seti/shared'
import { claudeCredentialMode } from './claude-credential.js'
import { githubTokenMode } from './github-token.js'
import { sandboxMcpServers } from './sandbox-mcp.js'
import { builtInHidden } from './sandbox.js'
import { sandboxContext } from './session-options.js'
import { sandboxPolicy } from './store/sandbox.js'

/** The sandbox setting, the credentials its proxy uses and what every task hides. */
export async function sandboxStatus(policy?: SandboxPolicy): Promise<SandboxStatus> {
  const current = policy ?? (await sandboxPolicy.get())
  return {
    policy: current,
    token_mode: await githubTokenMode(),
    claude_credential: await claudeCredentialMode(),
    built_in_hidden: builtInHidden(sandboxContext()),
    mcp_servers: sandboxMcpServers(current),
  }
}
