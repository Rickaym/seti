const SDK = '@anthropic-ai/claude-agent-sdk'

/** The Claude adapter, the only code that may import the Claude Agent SDK, types included. */
const SDK_HOMES = ['server/src/runtimes/claude/', 'shared/src/runtimes/claude/']

/**
 * Files outside the adapter that still import the SDK, each with the stage that removes the
 * import. The lists may only shrink: a test fails for a file here that no longer imports it.
 */
const SDK_ALLOWED = {
  /** Permission and hook glue: Claude's hook, permission and mode types until R3's neutral gate. */
  r3PolicyGlue: {
    'server/src/bypass-mode.ts': 'R3: PermissionMode, until a neutral permission mode',
    'server/src/bypass.ts': 'R3: PermissionMode, until a neutral permission mode',
    'server/src/house-rules.ts': 'R3: hook types, until a neutral pre-tool hook',
    'server/src/permission-guard.ts': 'R3: hook types, until a neutral pre-tool hook',
    'server/src/permission-policy.ts': 'R3: PermissionUpdate, until a neutral rule update',
    'server/src/permission-requests.ts': 'R3: CanUseTool and PermissionResult, until a neutral ask and answer',
    'server/src/question-answers.ts': 'R3: PermissionResult, until a neutral ask and answer',
    'server/src/questions.ts': 'R3: PermissionResult, until a neutral ask and answer',
    'server/src/repeat-hooks.ts': 'R3: hook types, until a neutral pre-tool hook',
    'server/src/review-hooks.ts': 'R3: hook types, until a neutral pre-tool hook',
    'server/src/runtime-host.ts': 'R3: CanUseTool and hook matchers, until neutral decide and hooks',
    'server/src/sandbox.ts': 'R3: hook types, until a neutral pre-tool hook',
    'server/src/shadow-hooks.ts': 'R3: hook types, until a neutral pre-tool hook',
    'server/src/turn-asks.ts': 'R3: PermissionResult and PermissionUpdate, until a neutral ask and answer',
    'ui/src/lib/session-labels.ts': 'R3: PermissionMode, until a neutral permission mode',
  },
  /** Claude's tools plane, launch and side chat, which R5 moves into the adapter. */
  r5ToolsAndLaunch: {
    'server/src/account.ts': 'R5: AccountInfo and login signals, until the adapter owns accounts',
    'server/src/capabilities.ts': 'R5: probe options and MCP status, until the adapter owns probes',
    'server/src/fake-sdk.ts': "R5: the e2e fake of Claude's SDK, until fakes live with each adapter",
    'server/src/plugins.ts': 'R5: SdkPluginConfig, until the adapter owns plugins',
    'server/src/shared-tools.ts': 'R5: MCP server configs, until the adapter owns its tools plane',
    'server/src/side-chat/answer.ts': "R5: the side chat's own Claude query, until the adapter owns it",
    'server/src/side-chat/ask.ts': "R5: the side chat's own Claude query, until the adapter owns it",
  },
  /** The rewind path, which the next R2 pull request moves into the adapter. */
  r2Rewind: {
    'server/src/rewind.ts': "R2 PR 11: Claude's session chain entries",
    'server/src/rewind-task.ts': "R2 PR 11: Claude's rewind files result",
  },
}

/**
 * No import of the SDK, types included, outside the adapter, tests and the allowed files.
 * @returns {import('eslint').Linter.Config}
 */
export function sdkFence() {
  const allowed = Object.values(SDK_ALLOWED).flatMap((group) => Object.keys(group))
  return {
    files: [
      'server/src/**/*.ts',
      'shared/src/**/*.ts',
      'ui/src/**/*.{ts,tsx}',
      'packages/**/*.{ts,tsx}',
      'mods/**/*.{ts,tsx}',
    ],
    ignores: [...SDK_HOMES.map((home) => `${home}**`), '**/*.test.ts', '**/*.test.tsx', ...allowed],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            { name: SDK, message: 'Reach Claude Code through its runtime adapter in server/src/runtimes/claude/.' },
          ],
        },
      ],
    },
  }
}
