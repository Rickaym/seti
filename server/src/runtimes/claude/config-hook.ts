import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'

/**
 * Keeps a sandboxed session on the folder settings it started with: a change to the folder's
 * project or local settings, by the agent or anyone, applies from the next session.
 */
export const folderConfigHook: HookCallbackMatcher = {
  hooks: [
    async (input) =>
      Promise.resolve(
        input.hook_event_name === 'ConfigChange' &&
          (input.source === 'project_settings' || input.source === 'local_settings')
          ? { decision: 'block' as const, reason: "The folder's settings apply from the agent's next session." }
          : {},
      ),
  ],
}
